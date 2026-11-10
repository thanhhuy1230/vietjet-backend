// UC-00 Auth (Nội bộ - Admin Center). Tách riêng khỏi routes/auth.js (customer):
// chỉ tài khoản có role ADMIN hoặc SUPPORT mới đăng nhập được ở đây. Cùng bảng `users`,
// KHÔNG tạo bảng admin_users riêng (đã xác nhận ở Phase 2 - giữ đúng phạm vi, không over-engineering).
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { staffLoginLimiter } = require('../middleware/rateLimit');
const { loginSchema, refreshSchema } = require('../schemas/auth');
const { issueRefreshToken, verifyRefreshToken, revokeRefreshToken } = require('../utils/refreshToken');

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;
const STAFF_ROLES = ['ADMIN', 'SUPPORT'];

const sign = (u, role, permissions = []) => jwt.sign({ sub: u.user_id, email: u.email, role, permissions }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '2h' });
const toPublicUser = row => ({ id: row.user_id, email: row.email, fullName: row.full_name, phone: row.phone, status: row.status });

router.post('/login', staffLoginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    // Ưu tiên ADMIN nếu 1 tài khoản nội bộ lỡ có cả 2 role (hiếm, nhưng giữ hành vi rõ ràng, không mơ hồ).
    const q = await db.query(
      `SELECT u.user_id,u.email,u.full_name,u.phone,u.status,u.password_hash,u.failed_login_count,u.locked_until,r.code role_code
       FROM users u
       JOIN user_roles ur ON ur.user_id=u.user_id
       JOIN roles r ON r.role_id=ur.role_id AND r.code = ANY($2)
       WHERE u.email=$1 AND u.status='ACTIVE'
       ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1`,
      [email, STAFF_ROLES]
    );
    const u = q.rows[0];

    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(u.locked_until) - new Date()) / 60000);
      return res.status(423).json({ code: 'ACCOUNT_LOCKED', message: `Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau ${minutesLeft} phút.` });
    }

    const ok = u && await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      if (u) {
        const c = (await db.query('UPDATE users SET failed_login_count=failed_login_count+1 WHERE user_id=$1 RETURNING failed_login_count', [u.user_id])).rows[0].failed_login_count;
        if (c >= LOCK_THRESHOLD) await db.query("UPDATE users SET locked_until=now()+($1||' minutes')::interval WHERE user_id=$2", [LOCK_MINUTES, u.user_id]);
      }
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'Email hoặc mật khẩu không đúng.' });
    }

    await db.query('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE user_id=$1', [u.user_id]);
    // Query permission codes cho SUPPORT (ADMIN bypass toàn bộ nên trả mảng rỗng).
    // Permission chỉ có hiệu lực khi nằm trong JWT → thay đổi permission cần đăng nhập/refresh lại.
    let permissions = [];
    if (u.role_code !== 'ADMIN') {
      const pq = await db.query('SELECT p.code FROM user_permissions up JOIN permissions p ON p.permission_id=up.permission_id WHERE up.user_id=$1', [u.user_id]);
      permissions = pq.rows.map(r => r.code);
    }
    const refreshToken = await issueRefreshToken(u.user_id);
    res.json({ accessToken: sign(u, u.role_code, permissions), refreshToken, user: { ...toPublicUser(u), role: u.role_code, permissions } });
  } catch (e) { next(e); }
});

router.post('/refresh', validateBody(refreshSchema), async (req, res, next) => {
  try {
    const userId = await verifyRefreshToken(req.body.refreshToken);
    if (!userId) return res.status(401).json({ code: 'REFRESH_TOKEN_INVALID', message: 'Refresh token không hợp lệ hoặc đã hết hạn.' });
    const q = await db.query(
      `SELECT u.user_id,u.email,r.code role_code FROM users u
       JOIN user_roles ur ON ur.user_id=u.user_id
       JOIN roles r ON r.role_id=ur.role_id AND r.code = ANY($2)
       WHERE u.user_id=$1 AND u.status='ACTIVE'
       ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END LIMIT 1`,
      [userId, STAFF_ROLES]
    );
    const u = q.rows[0];
    if (!u) return res.status(401).json({ code: 'REFRESH_TOKEN_INVALID', message: 'Refresh token không hợp lệ hoặc đã hết hạn.' });
    // Query permissions mới nhất khi refresh → ADMIN gán thêm quyền cho SUPPORT, SUPPORT refresh là có hiệu lực.
    let permissions = [];
    if (u.role_code !== 'ADMIN') {
      const pq = await db.query('SELECT p.code FROM user_permissions up JOIN permissions p ON p.permission_id=up.permission_id WHERE up.user_id=$1', [u.user_id]);
      permissions = pq.rows.map(r => r.code);
    }
    res.json({ accessToken: sign(u, u.role_code, permissions) });
  } catch (e) { next(e); }
});

router.post('/logout', validateBody(refreshSchema), async (req, res, next) => {
  try { await revokeRefreshToken(req.body.refreshToken); res.json({ success: true }); }
  catch (e) { next(e); }
});

module.exports = router;
