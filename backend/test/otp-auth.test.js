// Test luồng ĐĂNG NHẬP / ĐĂNG KÝ khách hàng bằng Email + SĐT + OTP (login/identify, login/verify, signup/request, signup/verify).
// Test chạy trên server + database THẬT (không mock), nên cần:
//   1) PostgreSQL đã migrate + seed (npm run migrate && npm run seed && npm run seed:demo)
//   2) Server chạy với OTP_DELIVERY=backend (để API trả devOtp, KHÔNG gửi SMS thật => không tốn tiền) và nới giới hạn OTP/giờ:
//        Windows PowerShell:  $env:OTP_DELIVERY="backend"; $env:OTP_RATE_LIMIT_PER_HOUR="1000"; npm start
//        Linux/macOS:         OTP_DELIVERY=backend OTP_RATE_LIMIT_PER_HOUR=1000 npm start
//   3) Ở cửa sổ khác:  npm test   (hoặc node --test test/otp-auth.test.js). Test đọc DATABASE_URL trong .env, phải là DB mà server đang dùng.
// Mỗi lần chạy dùng email / SĐT ngẫu nhiên nên không đụng dữ liệu có sẵn.
require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { hashOtp } = require('../src/utils/otpService');
const { createCustomer, conflictFromError } = require('../src/utils/customerAccount');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000/api/v1';
const rand = () => Math.random().toString(36).slice(2, 10);
const randPhone = () => '09' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
const mkInfo = (o = {}) => ({ familyName: 'Nguyễn', givenName: `Văn ${rand()}`, email: `u_${rand()}@example.com`, phone: randPhone(), dateOfBirth: '1995-04-12', ...o });
const POST = body => ({ method: 'POST', body: JSON.stringify(body) });

async function call(path, options = {}) {
  const r = await fetch(BASE + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (body.code === 'TOO_MANY_REQUESTS') throw new Error('Bị rate limit. Khởi động server với OTP_RATE_LIMIT_PER_HOUR=1000 rồi chạy lại test.');
  return { status: r.status, body };
}
const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n);
const usersByPhone = phone => count('SELECT count(*) n FROM users WHERE phone=$1', [phone]);
const otpRows = (phone, purpose) => count('SELECT count(*) n FROM phone_otps WHERE phone=$1 AND purpose=$2', [phone, purpose]);
const expireCooldown = (phone, purpose) => db.query("UPDATE phone_otps SET created_at=created_at-interval '2 minutes' WHERE phone=$1 AND purpose=$2", [phone, purpose]);
// Chèn trực tiếp 1 OTP biết trước mã (để kiểm tra tách purpose / chéo số điện thoại mà không phải chờ cooldown).
const plantOtp = (phone, purpose, code) => db.query("INSERT INTO phone_otps(phone,purpose,otp_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [phone, purpose, hashOtp(code)]);

// Tạo sẵn 1 khách hàng bằng SQL (không qua API, để không phụ thuộc rate limit của luồng /auth/register cũ).
async function insertCustomerDirect({ email, phone }) {
  const u = (await db.query("INSERT INTO users(phone,email,full_name,status) VALUES($1,$2,'Người khác','ACTIVE') RETURNING user_id", [phone, email])).rows[0];
  await db.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE code='CUSTOMER'", [u.user_id]);
}

async function requestSignupOtp(info) {
  const r = await call('/auth/signup/request', POST(info));
  assert.equal(r.status, 200, `signup/request lỗi: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.delivery, 'backend', 'Server phải chạy với OTP_DELIVERY=backend để test lấy được devOtp (xem hướng dẫn đầu file).');
  assert.match(r.body.devOtp, /^\d{6}$/);
  return r.body.devOtp;
}
async function registerCustomer(o) {
  const info = mkInfo(o);
  const otp = await requestSignupOtp(info);
  const v = await call('/auth/signup/verify', POST({ ...info, otp }));
  assert.equal(v.status, 201, `signup/verify lỗi: ${JSON.stringify(v.body)}`);
  return info;
}
async function requestLoginOtp(info) {
  const r = await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }));
  assert.equal(r.status, 200, `login/identify lỗi: ${JSON.stringify(r.body)}`);
  return r.body.devOtp;
}

test.after(() => db.pool.end());

test('Endpoint cũ đã được gỡ (không còn luồng "Hoàn thiện đăng ký")', async (t) => {
  await t.test('POST /auth/otp/request -> 404', async () => assert.equal((await call('/auth/otp/request', POST({ phone: '0912345678' }))).status, 404));
  await t.test('POST /auth/otp/verify -> 404', async () => assert.equal((await call('/auth/otp/verify', POST({ phone: '0912345678', otp: '123456' }))).status, 404));
  await t.test('POST /auth/register-phone -> 404', async () => assert.equal((await call('/auth/register-phone', POST({ phoneVerifyTicket: 'x' }))).status, 404));
});

test('ĐĂNG KÝ bước 1 - signup/request', async (t) => {
  await t.test('(1) trùng SĐT -> 409 PHONE_ALREADY_REGISTERED và KHÔNG tạo OTP mới', async () => {
    const a = await registerCustomer();
    const before = await otpRows(a.phone, 'signup');
    const r = await call('/auth/signup/request', POST(mkInfo({ phone: a.phone })));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PHONE_ALREADY_REGISTERED');
    assert.equal(r.body.field, 'phone');
    assert.equal(await otpRows(a.phone, 'signup'), before);
  });

  await t.test('(1) trùng email -> 409 EMAIL_ALREADY_REGISTERED, kể cả khác hoa/thường, và KHÔNG tạo OTP', async () => {
    const a = await registerCustomer();
    const phone = randPhone();
    const r = await call('/auth/signup/request', POST(mkInfo({ phone, email: a.email.toUpperCase() })));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'EMAIL_ALREADY_REGISTERED');
    assert.equal(await otpRows(phone, 'signup'), 0);
  });

  await t.test('(1) trùng với tài khoản KHÔNG phải khách (nhân viên) -> 409 IDENTITY_NOT_AVAILABLE', async () => {
    const byEmail = await call('/auth/signup/request', POST(mkInfo({ email: 'admin@vietjet.local' })));
    assert.equal(byEmail.status, 409);
    assert.equal(byEmail.body.code, 'IDENTITY_NOT_AVAILABLE');
    const byPhone = await call('/auth/signup/request', POST(mkInfo({ phone: '0900000001' })));
    assert.equal(byPhone.status, 409);
    assert.equal(byPhone.body.code, 'IDENTITY_NOT_AVAILABLE');
  });

  await t.test('(2) hợp lệ -> 200 và KHÔNG có dòng users mới (chỉ có 1 OTP purpose=signup)', async () => {
    const info = mkInfo();
    await requestSignupOtp(info);
    assert.equal(await usersByPhone(info.phone), 0);
    assert.equal(await count('SELECT count(*) n FROM users WHERE lower(email)=$1', [info.email]), 0);
    assert.equal(await otpRows(info.phone, 'signup'), 1);
    assert.equal(await otpRows(info.phone, 'login'), 0);
  });

  await t.test('gửi lại trong 60s -> 429 OTP_COOLDOWN; sau cooldown gửi được lại', async () => {
    const info = mkInfo();
    await requestSignupOtp(info);
    const again = await call('/auth/signup/request', POST(info));
    assert.equal(again.status, 429);
    assert.equal(again.body.code, 'OTP_COOLDOWN');
    await expireCooldown(info.phone, 'signup');
    await requestSignupOtp(info);
    assert.equal(await otpRows(info.phone, 'signup'), 2);
  });

  await t.test('dữ liệu sai -> 422 (email, ngày sinh tương lai, dưới 14 tuổi, ngày không tồn tại, field lạ, thiếu họ)', async () => {
    for (const bad of [
      mkInfo({ email: 'khong-phai-email' }), mkInfo({ dateOfBirth: '2999-01-01' }), mkInfo({ dateOfBirth: '2020-01-01' }),
      mkInfo({ dateOfBirth: '2000-02-31' }), { ...mkInfo(), role: 'ADMIN' }, mkInfo({ familyName: '' }), mkInfo({ phone: '123' }),
    ]) {
      const r = await call('/auth/signup/request', POST(bad));
      assert.equal(r.status, 422, JSON.stringify(bad));
      assert.equal(r.body.code, 'VALIDATION');
    }
  });
});

test('ĐĂNG KÝ bước 2 - signup/verify', async (t) => {
  await t.test('(3) sai OTP -> 401 OTP_INVALID, không tạo user; sai quá 5 lần -> OTP_LOCKED (kể cả nhập đúng sau đó)', async () => {
    const info = mkInfo();
    const otp = await requestSignupOtp(info);
    const wrong = otp === '000000' ? '111111' : '000000';
    const first = await call('/auth/signup/verify', POST({ ...info, otp: wrong }));
    assert.equal(first.status, 401);
    assert.equal(first.body.code, 'OTP_INVALID');
    assert.equal(await usersByPhone(info.phone), 0);
    for (let i = 0; i < 4; i++) await call('/auth/signup/verify', POST({ ...info, otp: wrong }));
    const locked = await call('/auth/signup/verify', POST({ ...info, otp }));
    assert.equal(locked.status, 401);
    assert.equal(locked.body.code, 'OTP_LOCKED');
    assert.equal(await usersByPhone(info.phone), 0);
  });

  await t.test('chưa gửi OTP mà verify -> 401 OTP_EXPIRED, không tạo user', async () => {
    const info = mkInfo();
    const r = await call('/auth/signup/verify', POST({ ...info, otp: '123456' }));
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OTP_EXPIRED');
    assert.equal(await usersByPhone(info.phone), 0);
  });

  await t.test('(4) đúng OTP -> 201, có role CUSTOMER, không có mật khẩu, không phát token; sau đó login/identify trả otpSent:true', async () => {
    const info = mkInfo();
    const otp = await requestSignupOtp(info);
    const v = await call('/auth/signup/verify', POST({ ...info, otp }));
    assert.equal(v.status, 201);
    assert.equal(v.body.accessToken, undefined);
    assert.equal(v.body.refreshToken, undefined);
    const u = (await db.query(
      `SELECT u.full_name,u.email,u.status,u.password_hash,to_char(u.date_of_birth,'YYYY-MM-DD') dob,
              (SELECT array_agg(r.code) FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id) roles
       FROM users u WHERE u.phone=$1`, [info.phone])).rows[0];
    assert.equal(u.full_name, `${info.familyName} ${info.givenName}`);
    assert.equal(u.email, info.email);
    assert.equal(u.dob, '1995-04-12');
    assert.equal(u.status, 'ACTIVE');
    assert.equal(u.password_hash, null);
    assert.deepEqual(u.roles, ['CUSTOMER']);
    const login = await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }));
    assert.equal(login.status, 200);
    assert.equal(login.body.otpSent, true);
  });

  await t.test('OTP chỉ dùng được 1 lần', async () => {
    const info = mkInfo();
    const otp = await requestSignupOtp(info);
    assert.equal((await call('/auth/signup/verify', POST({ ...info, otp }))).status, 201);
    // Bản đăng ký thứ hai cùng thông tin: bị chặn vì đã tồn tại (409), không tạo thêm user
    assert.equal((await call('/auth/signup/verify', POST({ ...info, otp }))).status, 409);
    assert.equal(await usersByPhone(info.phone), 1);
  });

  await t.test('(5) OTP purpose=login KHÔNG dùng được cho signup/verify (không có OTP signup -> OTP_EXPIRED)', async () => {
    const info = mkInfo();
    await plantOtp(info.phone, 'login', '123456');
    const r = await call('/auth/signup/verify', POST({ ...info, otp: '123456' }));
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OTP_EXPIRED');
    assert.equal(await usersByPhone(info.phone), 0);
  });

  await t.test('(5) có cả OTP login lẫn signup cho cùng SĐT: mã login không qua được signup/verify, mã signup không qua được login/verify', async () => {
    // signup: số mới, có OTP signup thật + OTP login cài sẵn
    const info = mkInfo();
    const signupOtp = await requestSignupOtp(info);
    const loginCode = signupOtp === '654321' ? '123456' : '654321';
    await plantOtp(info.phone, 'login', loginCode);
    const wrongPurpose = await call('/auth/signup/verify', POST({ ...info, otp: loginCode }));
    assert.equal(wrongPurpose.status, 401);
    assert.equal(wrongPurpose.body.code, 'OTP_INVALID');
    assert.equal(await usersByPhone(info.phone), 0);
    assert.equal((await call('/auth/signup/verify', POST({ ...info, otp: signupOtp }))).status, 201);

    // login: khách vừa tạo, có OTP login thật + OTP signup cài sẵn (cùng SĐT)
    await expireCooldown(info.phone, 'login'); // bỏ qua cooldown với dòng 'login' đã cài sẵn ở trên
    const loginOtp = await requestLoginOtp(info);
    const signupCode = loginOtp === '246810' ? '135790' : '246810';
    await plantOtp(info.phone, 'signup', signupCode);
    const wrong = await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: signupCode }));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'OTP_INVALID');
    assert.equal((await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: loginOtp }))).status, 200);
  });

  await t.test('(6) OTP của số A không dùng để đăng ký số B', async () => {
    const a = mkInfo(), b = mkInfo();
    const otpA = await requestSignupOtp(a);
    const r = await call('/auth/signup/verify', POST({ ...b, otp: otpA }));
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OTP_EXPIRED');
    assert.equal(await usersByPhone(b.phone), 0);
    assert.equal(await usersByPhone(a.phone), 0);
  });

  await t.test('email bị chiếm giữa lúc đang nhập OTP -> 409 EMAIL_ALREADY_REGISTERED, không tạo user, OTP chưa bị tiêu', async () => {
    const info = mkInfo();
    const otp = await requestSignupOtp(info);
    await insertCustomerDirect({ email: info.email, phone: randPhone() }); // người khác chiếm email này trong lúc đang chờ OTP
    const r = await call('/auth/signup/verify', POST({ ...info, otp }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'EMAIL_ALREADY_REGISTERED');
    assert.equal(await usersByPhone(info.phone), 0);
    assert.equal(await count('SELECT count(*) n FROM phone_otps WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL', [info.phone, 'signup']), 1);
  });

  await t.test('SĐT bị chiếm giữa lúc đang nhập OTP -> 409 PHONE_ALREADY_REGISTERED', async () => {
    const info = mkInfo();
    const otp = await requestSignupOtp(info);
    await insertCustomerDirect({ email: `o_${rand()}@example.com`, phone: info.phone }); // người khác chiếm SĐT này trong lúc đang chờ OTP
    const r = await call('/auth/signup/verify', POST({ ...info, otp }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PHONE_ALREADY_REGISTERED');
  });

  await t.test('(7) hai signup/verify SONG SONG cùng OTP -> đúng 1 user, 1 cái 201, cái còn lại 4xx, không có 500', async () => {
    const info = mkInfo();
    const otp = await requestSignupOtp(info);
    const rs = await Promise.all([call('/auth/signup/verify', POST({ ...info, otp })), call('/auth/signup/verify', POST({ ...info, otp }))]);
    const statuses = rs.map(r => r.status).sort();
    assert.equal(statuses.filter(s => s === 201).length, 1, JSON.stringify(rs.map(r => [r.status, r.body.code])));
    assert.ok(rs.every(r => r.status < 500), 'không được có lỗi 5xx');
    assert.ok([401, 409].includes(statuses[1]), `yêu cầu thua phải là 401 (OTP đã dùng) hoặc 409 (trùng): ${statuses}`);
    assert.equal(await usersByPhone(info.phone), 1);
  });

  await t.test('(7) đua ở tầng DB: 8 createCustomer song song cùng SĐT -> đúng 1 thành công, các lỗi còn lại đều đổi được thành 409 (23505 không thành 500)', async () => {
    const info = mkInfo();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createCustomer({ ...info, email: `race${i}_${rand()}@example.com` })));
    const ok = results.filter(r => r.status === 'fulfilled');
    const bad = results.filter(r => r.status === 'rejected');
    assert.equal(ok.length, 1);
    for (const r of bad) {
      const c = conflictFromError(r.reason);
      assert.ok(c, `lỗi không được map sang 409: ${r.reason && r.reason.message}`);
      assert.equal(c.status, 409);
      assert.equal(c.body.code, 'PHONE_ALREADY_REGISTERED');
    }
    assert.equal(await usersByPhone(info.phone), 1);
  });

  await t.test('(7) đua ở tầng DB: cùng email, khác SĐT -> đúng 1 thành công, còn lại EMAIL_ALREADY_REGISTERED', async () => {
    const email = `race_${rand()}@example.com`;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createCustomer({ ...mkInfo(), email })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results.filter(x => x.status === 'rejected')) {
      const c = conflictFromError(r.reason);
      assert.ok(c);
      assert.equal(c.body.code, 'EMAIL_ALREADY_REGISTERED');
    }
  });
});

test('ĐĂNG NHẬP bước 1 - login/identify', async (t) => {
  await t.test('(a) tài khoản đã có (khớp email + SĐT, gõ +84 và email hoa thường vẫn khớp) -> 200 otpSent, OTP purpose=login', async () => {
    const info = await registerCustomer();
    const r = await call('/auth/login/identify', POST({ email: info.email.toUpperCase(), phone: '+84' + info.phone.slice(1) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.exists, true);
    assert.equal(r.body.otpSent, true);
    assert.match(r.body.devOtp, /^\d{6}$/);
    assert.equal(await otpRows(info.phone, 'login'), 1);
  });

  await t.test('(b) chưa có tài khoản -> 404 ACCOUNT_NOT_FOUND (redirectTo=register), KHÔNG gửi OTP, KHÔNG tạo user', async () => {
    const info = mkInfo();
    const r = await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'ACCOUNT_NOT_FOUND');
    assert.equal(r.body.redirectTo, 'register');
    assert.equal(await otpRows(info.phone, 'login'), 0);
    assert.equal(await usersByPhone(info.phone), 0);
  });

  await t.test('(c) email thuộc người này, SĐT thuộc người khác (hoặc chỉ 1 trong 2 tồn tại) -> 409 IDENTITY_MISMATCH, không gửi OTP, không gợi ý đăng ký', async () => {
    const a = await registerCustomer(), b = await registerCustomer();
    const free = randPhone();
    for (const [email, phone] of [[a.email, b.phone], [a.email, free], [mkInfo().email, a.phone]]) {
      const r = await call('/auth/login/identify', POST({ email, phone }));
      assert.equal(r.status, 409, `${email} / ${phone}`);
      assert.equal(r.body.code, 'IDENTITY_MISMATCH');
      assert.equal(r.body.redirectTo, undefined);
    }
    assert.equal(await otpRows(free, 'login'), 0);
  });

  await t.test('(c) TÀI KHOẢN MỒ CÔI (có SĐT nhưng không có role CUSTOMER - đúng lỗi users_phone_unique trước đây): không đăng nhập, không đăng ký, không INSERT đè', async () => {
    const info = mkInfo();
    await db.query("INSERT INTO users(phone,email,full_name,status) VALUES($1,$2,'Mồ côi','ACTIVE')", [info.phone, info.email]);
    const login = await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }));
    assert.equal(login.status, 409);
    assert.equal(login.body.code, 'IDENTITY_MISMATCH');
    const signup = await call('/auth/signup/request', POST(info));
    assert.equal(signup.status, 409);
    assert.equal(signup.body.code, 'IDENTITY_NOT_AVAILABLE');
    assert.equal(await usersByPhone(info.phone), 1); // vẫn đúng 1 dòng, không có lỗi 500
    // Sau khi gán role CUSTOMER (database/fix-orphan-users.sql) thì đăng nhập được
    await db.query("INSERT INTO user_roles(user_id,role_id) SELECT u.user_id,r.role_id FROM users u,roles r WHERE u.phone=$1 AND r.code='CUSTOMER'", [info.phone]);
    assert.equal((await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }))).status, 200);
  });

  await t.test('(c) tài khoản nhân viên không dùng được cổng khách -> 409 IDENTITY_MISMATCH', async () => {
    const r = await call('/auth/login/identify', POST({ email: 'admin@vietjet.local', phone: '0900000001' }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'IDENTITY_MISMATCH');
  });

  await t.test('(d) tài khoản bị khoá/ngưng hoạt động -> 401 ACCOUNT_INACTIVE / 423 ACCOUNT_LOCKED, không gửi OTP', async () => {
    const info = await registerCustomer();
    await db.query("UPDATE users SET status='SUSPENDED' WHERE phone=$1", [info.phone]);
    const inactive = await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }));
    assert.equal(inactive.status, 401);
    assert.equal(inactive.body.code, 'ACCOUNT_INACTIVE');
    await db.query("UPDATE users SET status='ACTIVE', locked_until=now()+interval '10 minutes' WHERE phone=$1", [info.phone]);
    const locked = await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }));
    assert.equal(locked.status, 423);
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED');
    assert.equal(await otpRows(info.phone, 'login'), 0);
  });

  await t.test('gửi lại trong 60s -> 429 OTP_COOLDOWN; dữ liệu sai/field lạ -> 422', async () => {
    const info = await registerCustomer();
    await requestLoginOtp(info);
    assert.equal((await call('/auth/login/identify', POST({ email: info.email, phone: info.phone }))).status, 429);
    assert.equal((await call('/auth/login/identify', POST({ email: 'sai', phone: info.phone }))).status, 422);
    assert.equal((await call('/auth/login/identify', POST({ email: info.email, phone: info.phone, role: 'ADMIN' }))).status, 422);
  });
});

test('ĐĂNG NHẬP bước 2 - login/verify', async (t) => {
  await t.test('đúng OTP -> 200 accessToken + refreshToken, role CUSTOMER, token dùng được với /auth/me, và refresh token hoạt động', async () => {
    const info = await registerCustomer();
    const otp = await requestLoginOtp(info);
    const r = await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp }));
    assert.equal(r.status, 200);
    assert.ok(r.body.accessToken && r.body.refreshToken);
    assert.equal(r.body.user.role, 'CUSTOMER');
    assert.equal(r.body.user.email, info.email);
    assert.equal(r.body.isNewUser, undefined); // luồng cũ "isNewUser" đã bị gỡ
    const me = await call('/auth/me', { headers: { Authorization: `Bearer ${r.body.accessToken}` } });
    assert.equal(me.status, 200);
    assert.equal(me.body.phone, info.phone);
    assert.equal((await call('/auth/refresh', POST({ refreshToken: r.body.refreshToken }))).status, 200);
  });

  await t.test('sai OTP -> 401 OTP_INVALID; sai quá 5 lần -> OTP_LOCKED; OTP đã dùng không dùng lại được', async () => {
    const info = await registerCustomer();
    const otp = await requestLoginOtp(info);
    const wrong = otp === '000000' ? '111111' : '000000';
    assert.equal((await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: wrong }))).body.code, 'OTP_INVALID');
    for (let i = 0; i < 4; i++) await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: wrong }));
    assert.equal((await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp }))).body.code, 'OTP_LOCKED');

    await expireCooldown(info.phone, 'login');
    const fresh = await requestLoginOtp(info);
    assert.equal((await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: fresh }))).status, 200);
    const reuse = await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: fresh }));
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.code, 'OTP_EXPIRED');
  });

  await t.test('login/verify KHÔNG BAO GIỜ tạo user: email + SĐT chưa tồn tại -> 404, số users không đổi', async () => {
    const info = mkInfo();
    await plantOtp(info.phone, 'login', '123456'); // dù có OTP hợp lệ cho số đó
    const before = await count('SELECT count(*) n FROM users');
    const r = await call('/auth/login/verify', POST({ email: info.email, phone: info.phone, otp: '123456' }));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'ACCOUNT_NOT_FOUND');
    assert.equal(await count('SELECT count(*) n FROM users'), before);
  });

  await t.test('email không khớp SĐT của OTP -> 409, không đăng nhập được bằng OTP của người khác', async () => {
    const a = await registerCustomer(), b = await registerCustomer();
    const otpA = await requestLoginOtp(a);
    const r = await call('/auth/login/verify', POST({ email: b.email, phone: a.phone, otp: otpA }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'IDENTITY_MISMATCH');
  });
});

test('Cổng khách hàng (OTP) tách khỏi cổng nội bộ và luồng email+mật khẩu cũ', async (t) => {
  await t.test('tài khoản đăng ký bằng OTP (không có mật khẩu) đăng nhập qua /auth/login cũ -> 401 (không phải 400/500)', async () => {
    const info = await registerCustomer();
    const r = await call('/auth/login', POST({ email: info.email, password: 'Password123' }));
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'INVALID_CREDENTIALS');
  });
  await t.test('khách đăng ký bằng OTP không vào được cổng admin', async () => {
    const info = await registerCustomer();
    assert.equal((await call('/admin/auth/login', POST({ email: info.email, password: 'Password123' }))).status, 401);
  });
});
