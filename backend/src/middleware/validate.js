// Middleware validate body bằng zod.
// Giữ nguyên format lỗi hiện có của toàn hệ thống: {code,message,details} (khớp middleware/error.js).
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(422).json({
        code: 'VALIDATION',
        message: 'Dữ liệu gửi lên không hợp lệ.',
        details: result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    req.body = result.data; // đã parse: trim, lowercase email... theo schema
    next();
  };
}
module.exports = { validateBody };
