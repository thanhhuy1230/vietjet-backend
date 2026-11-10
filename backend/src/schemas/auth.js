// UC-00 Auth - schema validate bằng zod.
// Giữ triết lý hiện có: response lỗi vẫn là {code,message,details} (xem middleware/validate.js),
// KHÔNG đổi sang {success,error} của Swift247 để không phải sửa các route khác.
const { z } = require('zod');

// Có chữ + có số (khuyến nghị, không bắt buộc ký tự đặc biệt để không làm khó demo/thesis).
const strongPassword = z.string()
  .min(8, 'Mật khẩu tối thiểu 8 ký tự.')
  .regex(/[A-Za-z]/, 'Mật khẩu cần có ít nhất 1 chữ cái.')
  .regex(/[0-9]/, 'Mật khẩu cần có ít nhất 1 chữ số.');

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email không đúng định dạng.'),
  password: strongPassword,
  fullName: z.string().trim().min(1, 'Họ tên không được để trống.'),
  // Giữ optional như hành vi hiện tại của backend (đã xác nhận không đổi ở Phase 2).
  phone: z.string().trim().min(8, 'Số điện thoại không hợp lệ.').optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email không đúng định dạng.'),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Vui lòng nhập mật khẩu hiện tại.'),
  newPassword: strongPassword,
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20, 'refreshToken không hợp lệ.'),
});

// UC-00 Auth - đăng nhập khách hàng bằng số điện thoại + OTP tự triển khai ở backend
// (thay cho Firebase Phone Auth cũ - không chạy được trong Expo Go, xem otpProvider.js).
// Chuẩn hoá +84901234567 / 84901234567 / 0901 234 567 -> 0901234567 để cùng một số luôn khớp một tài khoản.
const normPhone = v => { let d = String(v).replace(/[\s.\-()]/g, ''); if (d.startsWith('+84')) d = '0' + d.slice(3); else if (/^84\d{9}$/.test(d)) d = '0' + d.slice(2); return d; };
const phoneSchema = z.string().trim().min(8, 'Số điện thoại không hợp lệ.').transform(normPhone).pipe(z.string().regex(/^0\d{9}$/, 'Số điện thoại phải gồm 10 số và bắt đầu bằng 0.'));

// ---- Đăng nhập khách hàng: 2 bước (Email + SĐT -> OTP). Đăng ký khách mới: 2 bước (thông tin -> OTP) ----
const emailSchema = z.string().trim().toLowerCase().email('Email không đúng định dạng.');
const otpSchema = z.string().trim().regex(/^\d{6}$/, 'Mã OTP gồm 6 chữ số.');
const nameSchema = label => z.string().trim().min(1, `${label} không được để trống.`).max(60, `${label} tối đa 60 ký tự.`);
const MIN_AGE_YEARS = 14;
// Ngày sinh YYYY-MM-DD: phải là ngày có thật (không có 2000-02-31), không ở tương lai, đủ tuổi tối thiểu.
const dobSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày sinh phải đúng định dạng YYYY-MM-DD.').refine(v => {
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}, 'Ngày sinh không tồn tại.').refine(v => v <= new Date().toISOString().slice(0, 10), 'Ngày sinh không được ở tương lai.').refine(v => {
  const limit = new Date(); limit.setUTCFullYear(limit.getUTCFullYear() - MIN_AGE_YEARS);
  return v <= limit.toISOString().slice(0, 10);
}, `Bạn cần từ ${MIN_AGE_YEARS} tuổi trở lên để đăng ký.`);

// Cập nhật hồ sơ khách hàng (Cài đặt -> Thông tin cá nhân). .strict() chặn mọi field lạ (role, status, userId...) - chống mass-assignment.
//  - Đổi số điện thoại BẮT BUỘC kèm phoneOtp (mã gửi tới số mới qua POST /auth/me/phone/request).
//  - hometown / nationalId gửi chuỗi rỗng = xóa thông tin. CCCD: đúng 12 chữ số.
const hometownSchema = z.string().trim().max(150, 'Quê quán tối đa 150 ký tự.');
const nationalIdSchema = z.string().trim().regex(/^(\d{12})?$/, 'Số căn cước công dân gồm đúng 12 chữ số.');
const updateMeSchema = z.object({
  fullName: z.string().trim().min(1, 'Họ tên không được để trống.').max(150, 'Họ tên tối đa 150 ký tự.').optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  phoneOtp: otpSchema.optional(),
  dateOfBirth: dobSchema.optional(),
  hometown: hometownSchema.optional(),
  nationalId: nationalIdSchema.optional(),
}).strict().refine(d => Object.keys(d).some(k => k !== 'phoneOtp' && d[k] !== undefined), {
  message: 'Cần ít nhất 1 trường để cập nhật.',
});
const phoneChangeRequestSchema = z.object({ phone: phoneSchema }).strict();

const loginIdentifySchema = z.object({ email: emailSchema, phone: phoneSchema }).strict();
const loginVerifySchema = z.object({ email: emailSchema, phone: phoneSchema, otp: otpSchema }).strict();

const signupInfo = { familyName: nameSchema('Họ'), givenName: nameSchema('Tên'), email: emailSchema, phone: phoneSchema, dateOfBirth: dobSchema };
const signupRequestSchema = z.object(signupInfo).strict();
const signupVerifySchema = z.object({ ...signupInfo, otp: otpSchema }).strict();

// Dùng cho POST /api/v1/admin/users (Super Admin cấp tài khoản nội bộ).
// permissionCodes: optional, nếu có thì gán permission ngay lúc tạo (chỉ áp dụng cho SUPPORT).
const createStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'Email không đúng định dạng.' }),
  password: z.string().min(6, { message: "Mật khẩu tạm cấp phải có ít nhất 6 ký tự." }),
  fullName: z.string().trim().min(1, { message: 'Họ tên không được để trống.' }).max(150),
  phone: z.string().trim().min(8, { message: 'Số điện thoại không hợp lệ.' }).max(30).optional(),
  role: z.enum(['ADMIN', 'SUPPORT'], { message: "role phải là 'ADMIN' hoặc 'SUPPORT'." }),
  permissionCodes: z.array(z.string()).optional(),
}).strict();

// Dùng cho PATCH /api/v1/admin/users/:id/permissions
const updatePermissionsSchema = z.object({
  role: z.enum(['ADMIN', 'SUPPORT'], { message: "role phải là 'ADMIN' hoặc 'SUPPORT'." }),
  permissionCodes: z.array(z.string()).optional(),
}).strict();

// Dùng cho PATCH /api/v1/admin/users/:id/status
const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE'], { message: "status phải là 'ACTIVE' hoặc 'INACTIVE'." }),
}).strict();

module.exports = { registerSchema, loginSchema, updateMeSchema, phoneChangeRequestSchema, changePasswordSchema, refreshSchema, createStaffSchema, updatePermissionsSchema, updateStatusSchema, loginIdentifySchema, loginVerifySchema, signupRequestSchema, signupVerifySchema };

