// Admin Center - QUẢN LÝ NHÂN VIÊN NỘI BỘ (ADMIN / SUPPORT) và phân quyền. Chỉ Super Admin (role ADMIN) được gọi.
// Các module nghiệp vụ khác nằm ở routes/adminCatalog.js (chuyến bay, khuyến mãi, dịch vụ) và routes/adminOps.js (còn lại).
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../db');
const { auth, allow } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { createStaffSchema, updatePermissionsSchema, updateStatusSchema } = require('../schemas/auth');
const { revokeAllForUser } = require('../utils/refreshToken');

router.use(auth());

const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const STAFF_SQL = `SELECT DISTINCT ON (u.user_id) u.user_id, u.email, u.full_name, u.phone, u.status, u.created_at, u.locked_until, r.code role_code,
    coalesce((SELECT array_agg(p.code ORDER BY p.code) FROM user_permissions up JOIN permissions p ON p.permission_id=up.permission_id WHERE up.user_id=u.user_id), '{}') permissions
  FROM users u JOIN user_roles ur ON ur.user_id=u.user_id JOIN roles r ON r.role_id=ur.role_id AND r.code IN ('ADMIN','SUPPORT')`;
const STAFF_ORDER = "ORDER BY u.user_id, CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END";
const toStaff = (r) => ({ id: r.user_id, email: r.email, fullName: r.full_name, phone: r.phone, status: r.status, role: r.role_code,
  permissions: r.role_code === 'ADMIN' ? [] : (r.permissions || []), createdAt: r.created_at, lockedUntil: r.locked_until });

async function getStaff(exec, id) {
  if (!isUuid(id)) return null;
  const r = (await exec.query(`${STAFF_SQL} WHERE u.user_id=$1 ${STAFF_ORDER}`, [id])).rows[0];
  return r ? toStaff(r) : null;
}
async function activeAdminCount(exec, exceptId) {
  return (await exec.query(`SELECT count(DISTINCT u.user_id)::int n FROM users u JOIN user_roles ur ON ur.user_id=u.user_id JOIN roles r ON r.role_id=ur.role_id
    WHERE r.code='ADMIN' AND u.status='ACTIVE' AND u.user_id<>$1`, [exceptId])).rows[0].n;
}
async function assertKnownPermissions(exec, codes) {
  if (!codes.length) return;
  const known = new Set((await exec.query('SELECT code FROM permissions WHERE code = ANY($1)', [codes])).rows.map((r) => r.code));
  const bad = codes.filter((c) => !known.has(c));
  if (bad.length) throw httpErr(422, 'PERMISSION_UNKNOWN', `Quyền không tồn tại: ${bad.join(', ')}`);
}
const dupMessage = (e) => (e.code === '23505' ? httpErr(409, 'DUPLICATE', /phone/i.test(e.constraint || e.detail || '') ? 'Số điện thoại đã được dùng cho tài khoản khác.' : 'Email đã được dùng cho tài khoản khác.') : e);

// GET /admin/permissions → toàn bộ quyền (render checkbox phân quyền)
router.get('/permissions', allow('ADMIN'), async (req, res, next) => {
  try { res.json({ items: (await db.query('SELECT code, name FROM permissions ORDER BY code')).rows }); } catch (e) { next(e); }
});

// GET /admin/users → danh sách nhân viên nội bộ (mỗi người 1 dòng, ưu tiên role ADMIN nếu có cả 2)
router.get('/users', allow('ADMIN'), async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT * FROM (${STAFF_SQL} ${STAFF_ORDER}) s ORDER BY CASE s.role_code WHEN 'ADMIN' THEN 0 ELSE 1 END, s.created_at DESC`)).rows;
    res.json({ items: rows.map(toStaff), currentUserId: req.user.sub });
  } catch (e) { next(e); }
});

// POST /admin/users → tạo tài khoản nội bộ (cách DUY NHẤT tạo ADMIN/SUPPORT)
router.post('/users', allow('ADMIN'), validateBody(createStaffSchema), async (req, res, next) => {
  try {
    const { email, password, fullName, phone, role } = req.body;
    const permissionCodes = role === 'SUPPORT' ? [...new Set(req.body.permissionCodes || [])] : [];
    const hash = await bcrypt.hash(password, 12);
    const id = await db.tx(async (c) => {
      await assertKnownPermissions(c, permissionCodes);
      const u = (await c.query("INSERT INTO users(email,password_hash,full_name,phone,status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING user_id", [email, hash, fullName, phone || null])).rows[0];
      await c.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE code=$2', [u.user_id, role]);
      if (permissionCodes.length) await c.query('INSERT INTO user_permissions(user_id,permission_id) SELECT $1,permission_id FROM permissions WHERE code = ANY($2)', [u.user_id, permissionCodes]);
      return u.user_id;
    });
    res.status(201).json(await getStaff(db, id));
  } catch (e) { next(dupMessage(e)); }
});

// PATCH /admin/users/:id → sửa họ tên / email / số điện thoại của nhân viên
router.patch('/users/:id', allow('ADMIN'), validateBody(z.object({
  fullName: z.string().trim().min(1, 'Họ tên không được để trống.').max(150).optional(),
  email: z.string().trim().toLowerCase().email('Email không đúng định dạng.').optional(),
  phone: z.string().trim().max(30).optional(),
}).strict()), async (req, res, next) => {
  try {
    if (!(await getStaff(db, req.params.id))) throw httpErr(404, 'USER_NOT_FOUND', 'Tài khoản không tồn tại hoặc không phải nhân viên nội bộ.');
    const v = req.body;
    if (v.phone !== undefined && v.phone && v.phone.length < 8) throw httpErr(422, 'VALIDATION', 'Số điện thoại không hợp lệ.');
    await db.query('UPDATE users SET full_name=coalesce($2,full_name), email=coalesce($3,email), phone=CASE WHEN $5 THEN nullif($4,\'\') ELSE phone END, updated_at=now() WHERE user_id=$1',
      [req.params.id, v.fullName ?? null, v.email ?? null, v.phone ?? null, v.phone !== undefined]);
    res.json({ message: 'Đã cập nhật thông tin nhân viên.', user: await getStaff(db, req.params.id) });
  } catch (e) { next(dupMessage(e)); }
});

// PATCH /admin/users/:id/permissions → đổi vai trò + thay TOÀN BỘ quyền
router.patch('/users/:id/permissions', allow('ADMIN'), validateBody(updatePermissionsSchema), async (req, res, next) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user.sub) return res.status(400).json({ code: 'SELF_ACTION', message: 'Không thể tự thay đổi quyền của chính mình.' });
    const target = await getStaff(db, targetId);
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại hoặc không phải nhân viên nội bộ.' });
    const { role } = req.body;
    const permissionCodes = role === 'SUPPORT' ? [...new Set(req.body.permissionCodes || [])] : [];
    await db.tx(async (c) => {
      if (target.role === 'ADMIN' && role !== 'ADMIN' && target.status === 'ACTIVE' && (await activeAdminCount(c, targetId)) === 0) throw httpErr(409, 'LAST_ADMIN', 'Phải còn ít nhất 1 quản trị viên đang hoạt động.');
      await assertKnownPermissions(c, permissionCodes);
      // Xóa role nội bộ cũ rồi gán role mới (tránh trùng khóa chính khi user lỡ có cả ADMIN và SUPPORT)
      await c.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id IN (SELECT role_id FROM roles WHERE code IN ('ADMIN','SUPPORT'))", [targetId]);
      await c.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,role_id FROM roles WHERE code=$2', [targetId, role]);
      await c.query('DELETE FROM user_permissions WHERE user_id=$1', [targetId]);
      if (permissionCodes.length) await c.query('INSERT INTO user_permissions(user_id,permission_id) SELECT $1,permission_id FROM permissions WHERE code = ANY($2)', [targetId, permissionCodes]);
    });
    res.json({ success: true, message: 'Đã cập nhật quyền truy cập. Nhân viên cần đăng nhập lại để áp dụng quyền mới.', user: await getStaff(db, targetId) });
  } catch (e) { next(e); }
});

// PATCH /admin/users/:id/status → khóa / mở khóa nhân viên (khóa = đăng xuất mọi phiên)
router.patch('/users/:id/status', allow('ADMIN'), validateBody(updateStatusSchema), async (req, res, next) => {
  try {
    if (req.params.id === req.user.sub) return res.status(400).json({ code: 'SELF_ACTION', message: 'Không thể khóa chính tài khoản của bạn.' });
    const target = await getStaff(db, req.params.id);
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại hoặc không phải nhân viên nội bộ.' });
    await db.tx(async (c) => {
      if (req.body.status !== 'ACTIVE' && target.role === 'ADMIN' && (await activeAdminCount(c, target.id)) === 0) throw httpErr(409, 'LAST_ADMIN', 'Phải còn ít nhất 1 quản trị viên đang hoạt động.');
      await c.query('UPDATE users SET status=$1, failed_login_count=0, locked_until=NULL, updated_at=now() WHERE user_id=$2', [req.body.status, target.id]);
      if (req.body.status !== 'ACTIVE') await revokeAllForUser(target.id, c);
    });
    res.json({ message: req.body.status === 'ACTIVE' ? 'Đã mở khóa tài khoản.' : 'Đã khóa tài khoản.' });
  } catch (e) { next(e); }
});

// PATCH /admin/users/:id/reset-password → cấp lại mật khẩu (đăng xuất mọi phiên cũ, gỡ khóa do nhập sai)
router.patch('/users/:id/reset-password', allow('ADMIN'), validateBody(z.object({ password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự.').max(100) })), async (req, res, next) => {
  try {
    const target = await getStaff(db, req.params.id);
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại hoặc không phải nhân viên nội bộ.' });
    const hash = await bcrypt.hash(req.body.password, 12);
    await db.tx(async (c) => {
      await c.query('UPDATE users SET password_hash=$1, failed_login_count=0, locked_until=NULL, updated_at=now() WHERE user_id=$2', [hash, target.id]);
      await revokeAllForUser(target.id, c);
    });
    res.json({ message: `Đã cấp lại mật khẩu cho ${target.email}.` });
  } catch (e) { next(e); }
});

// DELETE /admin/users/:id → xóa nhân viên. Dữ liệu làm việc (tin nhắn, hội thoại được phân công...) được giữ lại, chỉ bỏ liên kết.
router.delete('/users/:id', allow('ADMIN'), async (req, res, next) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user.sub) return res.status(400).json({ code: 'SELF_ACTION', message: 'Không thể tự xóa tài khoản của chính mình.' });
    const target = await getStaff(db, targetId);
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại hoặc không phải nhân viên nội bộ.' });
    await db.tx(async (c) => {
      if (target.role === 'ADMIN' && target.status === 'ACTIVE' && (await activeAdminCount(c, targetId)) === 0) throw httpErr(409, 'LAST_ADMIN', 'Phải còn ít nhất 1 quản trị viên đang hoạt động.');
      const isCustomerToo = (await c.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=$1 AND r.code='CUSTOMER'", [targetId])).rowCount;
      if (isCustomerToo) { // tài khoản cũng là khách hàng -> chỉ gỡ quyền nội bộ, giữ tài khoản khách
        await c.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id IN (SELECT role_id FROM roles WHERE code IN ('ADMIN','SUPPORT'))", [targetId]);
        await c.query('DELETE FROM user_permissions WHERE user_id=$1', [targetId]);
        return;
      }
      await c.query('UPDATE chat_conversations SET assigned_agent_id=NULL WHERE assigned_agent_id=$1', [targetId]);
      await c.query('UPDATE chat_messages SET sender_id=NULL WHERE sender_id=$1', [targetId]);
      await c.query('UPDATE flight_status_history SET changed_by=NULL WHERE changed_by=$1', [targetId]);
      await c.query('UPDATE audit_logs SET actor_id=NULL WHERE actor_id=$1', [targetId]);
      await c.query('UPDATE notifications SET created_by=NULL WHERE created_by=$1', [targetId]);
      await c.query('DELETE FROM users WHERE user_id=$1', [targetId]);
    });
    res.json({ message: 'Đã xóa tài khoản nhân viên.' });
  } catch (e) {
    if (e.code === '23503') return res.status(409).json({ code: 'FK_VIOLATION', message: 'Tài khoản đang gắn với dữ liệu khác (đặt chỗ, đánh giá...). Hãy dùng chức năng "Khóa" thay vì xóa.' });
    next(e);
  }
});

module.exports = router;
