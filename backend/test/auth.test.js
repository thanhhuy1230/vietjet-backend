// UC-00 Auth - test tự động (Node 22 built-in test runner, không cần cài thêm dependency).
// Cách chạy: 1) npm start (hoặc docker compose up) để server chạy ở http://localhost:3000
//            2) node --test test/auth.test.js
// Dùng email ngẫu nhiên mỗi lần chạy để không đụng dữ liệu seed / lần chạy trước.
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000/api/v1';
const rand = () => Math.random().toString(36).slice(2, 10);

async function call(path, options = {}) {
  const r = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

test('UC-00 Auth - Register', async (t) => {
  const email = `test_${rand()}@example.com`;

  await t.test('đăng ký hợp lệ -> 201, không có role/password trong response', async () => {
    const { status, body } = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'Password123', fullName: 'Test User' }) });
    assert.equal(status, 201);
    assert.equal(body.email, email);
    assert.equal(body.password_hash, undefined);
    assert.equal(body.role, undefined); // register không trả role, /me mới trả
  });

  await t.test('role injection -> vẫn chỉ là CUSTOMER (kiểm tra qua login, không login được cổng admin)', async () => {
    const adminAttempt = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Password123' }) });
    assert.equal(adminAttempt.status, 401); // không có role ADMIN/SUPPORT nên không vào được cổng admin
  });

  await t.test('trùng email -> 409', async () => {
    const { status, body } = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'Password123', fullName: 'Dup' }) });
    assert.equal(status, 409);
    assert.equal(body.code, 'DUPLICATE');
  });

  await t.test('password ngắn -> 422 VALIDATION', async () => {
    const { status, body } = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: `x_${rand()}@example.com`, password: '123', fullName: 'X' }) });
    assert.equal(status, 422);
    assert.equal(body.code, 'VALIDATION');
  });

  await t.test('thiếu fullName -> 422', async () => {
    const { status } = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: `y_${rand()}@example.com`, password: 'Password123' }) });
    assert.equal(status, 422);
  });

  await t.test('email sai định dạng -> 422', async () => {
    const { status } = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: 'not-an-email', password: 'Password123', fullName: 'X' }) });
    assert.equal(status, 422);
  });
});

test('UC-00 Auth - Login & tách cổng admin/customer', async (t) => {
  const email = `login_${rand()}@example.com`;
  await call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'Password123', fullName: 'Login Test' }) });

  await t.test('đăng nhập đúng -> có accessToken + refreshToken', async () => {
    const { status, body } = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Password123' }) });
    assert.equal(status, 200);
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.equal(body.user.role, 'CUSTOMER');
  });

  await t.test('sai mật khẩu -> 401, message chung chung (không lộ email tồn tại hay không)', async () => {
    const wrongEmail = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'khong-ton-tai@example.com', password: 'Password123' }) });
    const wrongPassword = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'saiRoi123' }) });
    assert.equal(wrongEmail.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongEmail.body.message, wrongPassword.body.message);
  });

  await t.test('khách hàng KHÔNG login được qua cổng admin', async () => {
    const { status } = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Password123' }) });
    assert.equal(status, 401);
  });

  await t.test('admin@vietjet.local KHÔNG login được qua cổng khách hàng', async () => {
    const { status } = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@vietjet.local', password: 'Vietjet@123' }) });
    assert.equal(status, 401);
  });

  await t.test('admin@vietjet.local login được qua cổng nội bộ, role=ADMIN', async () => {
    const { status, body } = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@vietjet.local', password: 'Vietjet@123' }) });
    assert.equal(status, 200);
    assert.equal(body.user.role, 'ADMIN');
  });
});

test('UC-00 Auth - Account lock (5 lần sai / 15 phút)', async (t) => {
  const email = `lock_${rand()}@example.com`;
  await call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'Password123', fullName: 'Lock Test' }) });

  await t.test('sai 5 lần liên tiếp rồi lần 6 phải bị khoá 423', async () => {
    for (let i = 0; i < 5; i++) {
      const { status } = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'saiRoi' }) });
      assert.equal(status, 401);
    }
    const { status, body } = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Password123' }) }); // đúng mật khẩu cũng phải bị chặn
    assert.equal(status, 423);
    assert.equal(body.code, 'ACCOUNT_LOCKED');
  });
});

test('UC-00 Auth - Me / Update profile / Change password', async (t) => {
  const email = `profile_${rand()}@example.com`;
  await call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password: 'Password123', fullName: 'Profile Test' }) });
  const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Password123' }) });
  const auth = { Authorization: `Bearer ${login.body.accessToken}` };

  await t.test('GET /me không auth -> 401', async () => {
    const { status } = await call('/auth/me');
    assert.equal(status, 401);
  });

  await t.test('GET /me có auth -> 200, không lộ password', async () => {
    const { status, body } = await call('/auth/me', { headers: auth });
    assert.equal(status, 200);
    assert.equal(body.email, email);
    assert.equal(body.password, undefined);
    assert.equal(body.password_hash, undefined);
  });

  await t.test('PATCH /me với field lạ (role) -> 422, bị chặn', async () => {
    const { status } = await call('/auth/me', { method: 'PATCH', headers: auth, body: JSON.stringify({ role: 'ADMIN' }) });
    assert.equal(status, 422);
  });

  await t.test('PATCH /me hợp lệ -> cập nhật thành công', async () => {
    const { status, body } = await call('/auth/me', { method: 'PATCH', headers: auth, body: JSON.stringify({ fullName: 'Đã đổi tên' }) });
    assert.equal(status, 200);
    assert.equal(body.fullName, 'Đã đổi tên');
  });

  await t.test('change-password sai mật khẩu hiện tại -> 400', async () => {
    const { status } = await call('/auth/change-password', { method: 'PATCH', headers: auth, body: JSON.stringify({ currentPassword: 'saiRoi', newPassword: 'NewPassword123' }) });
    assert.equal(status, 400);
  });

  await t.test('change-password đúng -> refresh token cũ bị thu hồi ngay', async () => {
    const { status } = await call('/auth/change-password', { method: 'PATCH', headers: auth, body: JSON.stringify({ currentPassword: 'Password123', newPassword: 'NewPassword123' }) });
    assert.equal(status, 200);
    const refreshAttempt = await call('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: login.body.refreshToken }) });
    assert.equal(refreshAttempt.status, 401);
    const reLogin = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'NewPassword123' }) });
    assert.equal(reLogin.status, 200);
  });
});

test('UC-00 Auth - RBAC nội bộ (ADMIN vs SUPPORT)', async (t) => {
  const adminLogin = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@vietjet.local', password: 'Vietjet@123' }) });
  const supportLogin = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'support@vietjet.local', password: 'Vietjet@123' }) });
  const adminAuth = { Authorization: `Bearer ${adminLogin.body.accessToken}` };
  const supportAuth = { Authorization: `Bearer ${supportLogin.body.accessToken}` };

  // Quyền của SUPPORT được cấp theo từng nhân viên: tài khoản support mẫu mặc định chưa có quyền nào,
  // nên ADMIN cấp quyền chats.manage + reviews.manage trước, rồi SUPPORT đăng nhập lại để nhận quyền mới.
  const supportId = supportLogin.body.user.id;
  const grant = await call(`/admin/users/${supportId}/permissions`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ role: 'SUPPORT', permissionCodes: ['chats.manage', 'reviews.manage'] }) });
  assert.equal(grant.status, 200);
  const relogin = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'support@vietjet.local', password: 'Vietjet@123' }) });
  supportAuth.Authorization = `Bearer ${relogin.body.accessToken}`;

  try {
  await t.test('SUPPORT được cấp quyền chats.manage, reviews.manage vào được /admin/chats và /admin/reviews', async () => {
    assert.equal((await call('/admin/chats', { headers: supportAuth })).status, 200);
    assert.equal((await call('/admin/reviews', { headers: supportAuth })).status, 200);
  });

  await t.test('SUPPORT KHÔNG vào được /admin/promotions', async () => {
    assert.equal((await call('/admin/promotions', { headers: supportAuth })).status, 403);
  });

  await t.test('SUPPORT KHÔNG tạo được tài khoản nội bộ', async () => {
    const { status } = await call('/admin/users', { method: 'POST', headers: supportAuth, body: JSON.stringify({ email: `staff_${rand()}@vietjet.local`, fullName: 'X', role: 'SUPPORT' }) });
    assert.equal(status, 403);
  });

  await t.test('ADMIN tạo được tài khoản SUPPORT mới, đăng nhập ngay bằng mật khẩu tạm', async () => {
    const email = `staff_${rand()}@vietjet.local`;
    const tempPassword = 'TamThoi@123'; // API tạo nhân viên bắt buộc ADMIN cấp mật khẩu tạm
    const created = await call('/admin/users', { method: 'POST', headers: adminAuth, body: JSON.stringify({ email, password: tempPassword, fullName: 'Nhân viên mới', role: 'SUPPORT' }) });
    assert.equal(created.status, 201);
    const login = await call('/admin/auth/login', { method: 'POST', body: JSON.stringify({ email, password: tempPassword }) });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'SUPPORT');
  });

  await t.test('ADMIN vào được mọi resource', async () => {
    assert.equal((await call('/admin/promotions', { headers: adminAuth })).status, 200);
  });
  } finally {
    // Trả tài khoản support mẫu về trạng thái ban đầu (chưa được cấp quyền)
    await call(`/admin/users/${supportId}/permissions`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ role: 'SUPPORT', permissionCodes: [] }) });
  }
});
