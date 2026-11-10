// UC-00 Auth (Customer). Đăng nhập ở đây CHỈ dành cho tài khoản có role CUSTOMER
// (tách riêng khỏi routes/adminAuth.js - đăng nhập nội bộ ADMIN/SUPPORT).
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { loginLimiter, registerLimiter, loginIdentifyLimiter, signupRequestLimiter, loginVerifyLimiter, signupVerifyLimiter } = require('../middleware/rateLimit');
const { registerSchema, loginSchema, updateMeSchema, phoneChangeRequestSchema, changePasswordSchema, refreshSchema, loginIdentifySchema, loginVerifySchema, signupRequestSchema, signupVerifySchema } = require('../schemas/auth');
const { issueRefreshToken, verifyRefreshToken, revokeRefreshToken, revokeAllForUser } = require('../utils/refreshToken');
const { issueOtp, verifyOtp } = require('../utils/otpService');
const { signupConflict, conflictFromError, createCustomer, resolveLoginUser } = require('../utils/customerAccount');

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

const sign = u => jwt.sign({ sub: u.user_id, email: u.email, role: 'CUSTOMER' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '2h' });

// Chuẩn hoá 1 row users (snake_case) -> camelCase cho response (đã xác nhận ở Phase 2, mục 7).
const toPublicUser = row => ({ id: row.user_id, email: row.email, fullName: row.full_name, phone: row.phone, status: row.status, dateOfBirth: row.date_of_birth || null, hometown: row.hometown || null, nationalId: row.national_id || null });
// Các cột hồ sơ trả về cho app (ngày sinh định dạng YYYY-MM-DD, tránh lệch múi giờ khi pg đọc kiểu date).
const PROFILE_COLS = "user_id,email,full_name,phone,status,to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth,hometown,national_id";

router.post('/register', registerLimiter, validateBody(registerSchema), async (req, res, next) => {
  try {
    const { email, password, fullName, phone } = req.body;
    const hash = await bcrypt.hash(password, 12);
    const result = await db.tx(async c => {
      const u = (await c.query(
        'INSERT INTO users(email,password_hash,full_name,phone) VALUES($1,$2,$3,$4) RETURNING user_id,email,full_name,phone,status',
        [email, hash, fullName, phone || null]
      )).rows[0];
      await c.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE code='CUSTOMER'", [u.user_id]);
      return u;
    });
    res.status(201).json(toPublicUser(result));
  } catch (e) { next(e); }
});

router.post('/login', loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const q = await db.query(
      `SELECT u.user_id,u.email,u.full_name,u.phone,u.status,u.password_hash,u.failed_login_count,u.locked_until
       FROM users u
       WHERE u.email=$1 AND u.status='ACTIVE'
         AND EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND r.code='CUSTOMER')`,
      [email]
    );
    const u = q.rows[0];

    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(u.locked_until) - new Date()) / 60000);
      return res.status(423).json({ code: 'ACCOUNT_LOCKED', message: `Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau ${minutesLeft} phút.` });
    }

    const ok = u && u.password_hash && await bcrypt.compare(password, u.password_hash); // tài khoản đăng ký bằng OTP không có mật khẩu
    if (!ok) {
      if (u) { // chỉ đếm khi email tồn tại và có role CUSTOMER - không leak sự tồn tại của email qua timing/behaviour khác
        const c = (await db.query('UPDATE users SET failed_login_count=failed_login_count+1 WHERE user_id=$1 RETURNING failed_login_count', [u.user_id])).rows[0].failed_login_count;
        if (c >= LOCK_THRESHOLD) await db.query("UPDATE users SET locked_until=now()+($1||' minutes')::interval WHERE user_id=$2", [LOCK_MINUTES, u.user_id]);
      }
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Email hoặc mật khẩu không đúng.' });
    }

    await db.query('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE user_id=$1', [u.user_id]);
    const refreshToken = await issueRefreshToken(u.user_id);
    res.json({ accessToken: sign(u), refreshToken, user: { ...toPublicUser(u), role: 'CUSTOMER' } });
  } catch (e) { next(e); }
});

// ======================= KHÁCH HÀNG: ĐĂNG NHẬP và ĐĂNG KÝ (tách riêng hoàn toàn) =======================
// ĐĂNG NHẬP (2 bước xác thực): Email + SĐT -> OTP SMS. Đăng nhập KHÔNG BAO GIỜ tạo user mới.
// ĐĂNG KÝ  (2 bước): nhập đủ thông tin -> OTP SMS; chỉ khi OTP đúng mới tạo tài khoản (không có dòng users "dở dang").
// Lưu ý: ACCOUNT_NOT_FOUND / IDENTITY_MISMATCH cho biết email/SĐT có tồn tại hay không (chủ đích để chuyển khách sang đăng ký);
// các endpoint bước 1 đều có rate limit riêng để hạn chế dò tài khoản.

// Đăng nhập bước 1: kiểm tra tài khoản rồi gửi OTP.
//   200 { exists:true, otpSent:true, ... } | 404 ACCOUNT_NOT_FOUND (-> sang đăng ký) | 409 IDENTITY_MISMATCH | 401/423 tài khoản bị khoá
router.post('/login/identify', loginIdentifyLimiter, validateBody(loginIdentifySchema), async (req, res, next) => {
  try {
    const { email, phone } = req.body;
    const found = await resolveLoginUser(email, phone);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const sent = await issueOtp(phone, 'login');
    if (!sent.ok) return res.status(sent.status).json(sent.body);
    res.json({ exists: true, ...sent.body });
  } catch (e) { next(e); }
});

// Đăng nhập bước 2: xác nhận OTP -> phát JWT.
router.post('/login/verify', loginVerifyLimiter, validateBody(loginVerifySchema), async (req, res, next) => {
  try {
    const { email, phone, otp } = req.body;
    const found = await resolveLoginUser(email, phone);
    if (found.error) return res.status(found.error.status).json(found.error.body);
    const checked = await verifyOtp(phone, 'login', otp);
    if (!checked.ok) return res.status(checked.status).json(checked.body);
    const u = found.user;
    const refreshToken = await issueRefreshToken(u.user_id);
    res.json({ accessToken: sign(u), refreshToken, user: { ...toPublicUser(u), role: 'CUSTOMER' } });
  } catch (e) { next(e); }
});

// Đăng ký bước 1: kiểm tra trùng TRƯỚC (không tốn SMS vô ích) rồi gửi OTP. KHÔNG tạo user ở bước này.
router.post('/signup/request', signupRequestLimiter, validateBody(signupRequestSchema), async (req, res, next) => {
  try {
    const { email, phone } = req.body;
    const clash = await signupConflict(db, email, phone);
    if (clash) return res.status(clash.status).json(clash.body);
    const sent = await issueOtp(phone, 'signup');
    if (!sent.ok) return res.status(sent.status).json(sent.body);
    res.json(sent.body);
  } catch (e) { next(e); }
});

// Đăng ký bước 2: client gửi lại toàn bộ thông tin + OTP (backend không lưu dữ liệu chờ). OTP đúng -> tạo tài khoản CUSTOMER.
// Không phát token: khách quay về màn Đăng nhập và đăng nhập bằng Email + SĐT + OTP.
router.post('/signup/verify', signupVerifyLimiter, validateBody(signupVerifySchema), async (req, res, next) => {
  try {
    const { otp, ...info } = req.body;
    const early = await signupConflict(db, info.email, info.phone); // trùng thì báo ngay, chưa tiêu OTP
    if (early) return res.status(early.status).json(early.body);
    const checked = await verifyOtp(info.phone, 'signup', otp);
    if (!checked.ok) return res.status(checked.status).json(checked.body);
    try {
      await createCustomer(info);
    } catch (err) {
      const clash = conflictFromError(err); // 2 yêu cầu song song: ràng buộc unique của DB (23505) -> 409, không bao giờ 500 vì trùng
      if (clash) return res.status(clash.status).json(clash.body);
      throw err;
    }
    res.status(201).json({ message: 'Đăng ký thành công, vui lòng đăng nhập.' });
  } catch (e) { next(e); }
});

router.post('/refresh', validateBody(refreshSchema), async (req, res, next) => {
  try {
    const userId = await verifyRefreshToken(req.body.refreshToken);
    if (!userId) return res.status(401).json({ code: 'REFRESH_TOKEN_INVALID', message: 'Refresh token không hợp lệ hoặc đã hết hạn.' });
    const q = await db.query(
      `SELECT u.user_id,u.email FROM users u
       WHERE u.user_id=$1 AND u.status='ACTIVE'
         AND EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND r.code='CUSTOMER')`,
      [userId]
    );
    const u = q.rows[0];
    if (!u) return res.status(401).json({ code: 'REFRESH_TOKEN_INVALID', message: 'Refresh token không hợp lệ hoặc đã hết hạn.' });
    res.json({ accessToken: sign(u) });
  } catch (e) { next(e); }
});

router.post('/logout', validateBody(refreshSchema), async (req, res, next) => {
  try { await revokeRefreshToken(req.body.refreshToken); res.json({ success: true }); }
  catch (e) { next(e); }
});

router.get('/me', auth(), async (req, res, next) => {
  try {
    const q = await db.query(`SELECT ${PROFILE_COLS} FROM users WHERE user_id=$1`, [req.user.sub]);
    if (!q.rowCount) return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy người dùng.' });
    res.json({ ...toPublicUser(q.rows[0]), role: req.user.role });
  } catch (e) { next(e); }
});

// Email / SĐT mới đã thuộc tài khoản khác chưa? Trả { status, body } (409) hoặc null.
async function profileConflict(userId, { email, phone }) {
  const { rows } = await db.query(
    'SELECT phone, lower(email) AS email FROM users WHERE user_id<>$1 AND ((phone IS NOT NULL AND phone=$2) OR lower(email)=$3)',
    [userId, phone || null, email || null]
  );
  if (phone && rows.some(r => r.phone === phone)) return { status: 409, body: { code: 'PHONE_ALREADY_REGISTERED', message: 'Số điện thoại này đã được dùng cho tài khoản khác.', field: 'phone' } };
  if (email && rows.some(r => r.email === email)) return { status: 409, body: { code: 'EMAIL_ALREADY_REGISTERED', message: 'Email này đã được dùng cho tài khoản khác.', field: 'email' } };
  return null;
}

// Đổi số điện thoại bước 1: gửi OTP tới SỐ MỚI (xác nhận chủ số trước khi đổi - vì SĐT là danh tính đăng nhập).
router.post('/me/phone/request', auth(), signupRequestLimiter, validateBody(phoneChangeRequestSchema), async (req, res, next) => {
  try {
    const { phone } = req.body;
    const cur = (await db.query('SELECT phone FROM users WHERE user_id=$1', [req.user.sub])).rows[0];
    if (!cur) return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy người dùng.' });
    if (cur.phone === phone) return res.status(422).json({ code: 'PHONE_UNCHANGED', message: 'Đây đang là số điện thoại hiện tại của bạn.', field: 'phone' });
    const clash = await profileConflict(req.user.sub, { phone });
    if (clash) return res.status(clash.status).json(clash.body);
    const sent = await issueOtp(phone, 'change_phone');
    if (!sent.ok) return res.status(sent.status).json(sent.body);
    res.json(sent.body);
  } catch (e) { next(e); }
});

// Cập nhật hồ sơ: họ tên, email, SĐT (kèm phoneOtp), ngày sinh, quê quán, CCCD. Chỉ cập nhật những trường được gửi lên.
router.patch('/me', auth(), validateBody(updateMeSchema), async (req, res, next) => {
  try {
    const { fullName, email, phone, phoneOtp, dateOfBirth, hometown, nationalId } = req.body;
    const cur = (await db.query('SELECT email, phone FROM users WHERE user_id=$1', [req.user.sub])).rows[0];
    if (!cur) return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy người dùng.' });

    const emailChanged = email !== undefined && email !== String(cur.email || '').toLowerCase();
    const phoneChanged = phone !== undefined && phone !== cur.phone;

    if (emailChanged || phoneChanged) { // kiểm tra trùng TRƯỚC khi xét OTP để không "đốt" mã của khách
      const clash = await profileConflict(req.user.sub, { email: emailChanged ? email : null, phone: phoneChanged ? phone : null });
      if (clash) return res.status(clash.status).json(clash.body);
    }
    if (phoneChanged) {
      if (!phoneOtp) return res.status(422).json({ code: 'PHONE_OTP_REQUIRED', message: 'Đổi số điện thoại cần nhập mã OTP gửi tới số mới.', field: 'phone' });
      const checked = await verifyOtp(phone, 'change_phone', phoneOtp);
      // Trả 400 thay vì 401: app tự làm mới token và gọi lại khi gặp 401, sẽ làm mỗi lần nhập sai bị tính thành 2 lượt.
      if (!checked.ok) return res.status(checked.status === 401 ? 400 : checked.status).json(checked.body);
    }

    const sets = [], vals = [req.user.sub];
    const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); }; // tên cột là hằng cố định, giá trị luôn qua tham số
    if (fullName !== undefined) add('full_name', fullName);
    if (emailChanged) add('email', email);
    if (phoneChanged) add('phone', phone);
    if (dateOfBirth !== undefined) add('date_of_birth', dateOfBirth);
    if (hometown !== undefined) add('hometown', hometown || null);
    if (nationalId !== undefined) add('national_id', nationalId || null);
    if (!sets.length) {
      const same = await db.query(`SELECT ${PROFILE_COLS} FROM users WHERE user_id=$1`, [req.user.sub]);
      return res.json(toPublicUser(same.rows[0]));
    }
    sets.push('updated_at=now()');
    const q = await db.query(`UPDATE users SET ${sets.join(', ')} WHERE user_id=$1 RETURNING ${PROFILE_COLS}`, vals);
    res.json(toPublicUser(q.rows[0]));
  } catch (e) {
    const c = conflictFromError(e); // 2 yêu cầu song song lọt qua kiểm tra -> ràng buộc unique của DB chặn (23505)
    if (c) return res.status(c.status).json(c.body);
    next(e);
  }
});

router.patch('/change-password', auth(), validateBody(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const q = await db.query('SELECT password_hash FROM users WHERE user_id=$1', [req.user.sub]);
    const row = q.rows[0];
    if (!row) {
      return res.status(400).json({ code: 'INVALID_PASSWORD', message: 'Mật khẩu hiện tại không đúng.' });
    }
    // User đăng nhập bằng OTP số điện thoại: password_hash là NULL → bcrypt.compare ném lỗi "Illegal arguments: string, object".
    if (!row.password_hash) {
      return res.status(400).json({ code: 'NO_PASSWORD_SET', message: 'Tài khoản này đăng nhập bằng OTP, chưa có mật khẩu. Vui lòng đặt mật khẩu mới thay vì đổi mật khẩu.' });
    }
    if (!await bcrypt.compare(currentPassword, row.password_hash)) {
      return res.status(400).json({ code: 'INVALID_PASSWORD', message: 'Mật khẩu hiện tại không đúng.' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await db.tx(async c => {
      await c.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE user_id=$2', [hash, req.user.sub]);
      await revokeAllForUser(req.user.sub, c); // thu hồi mọi phiên refresh cũ - đúng yêu cầu khoá luận mục 3.7
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
