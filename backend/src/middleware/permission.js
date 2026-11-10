// RBAC permission-based middleware. ADMIN (Super Admin) luôn bypass toàn bộ check.
// SUPPORT chỉ truy cập được module nào có permission_code tương ứng trong JWT payload.
// Thay đổi permission cho nhân viên chỉ có hiệu lực sau khi họ đăng nhập/refresh lại
// (permission nằm trong JWT, không query DB runtime → nhanh, không bottleneck).
function requirePermission(code) {
  return (req, res, next) => {
    // Super Admin bypass toàn bộ permission check
    if (req.user && req.user.role === 'ADMIN') return next();
    // Kiểm tra mảng permissions trong JWT payload
    if (req.user && Array.isArray(req.user.permissions) && req.user.permissions.includes(code)) return next();
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' });
  };
}

module.exports = { requirePermission };

