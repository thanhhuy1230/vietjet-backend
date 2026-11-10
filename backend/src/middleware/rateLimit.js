// Chỉ áp cho endpoint nhạy cảm (login/register), không áp rate-limit toàn cục
// để không ảnh hưởng các route khác đang chạy (flights/bookings/...).
// Tách riêng limiter cho cổng khách hàng và cổng nội bộ (đúng tinh thần "tách cổng đăng nhập"
// đã xác nhận) - tránh 2 luồng dùng chung 1 bộ đếm gây rate-limit chéo lẫn nhau.
const rateLimit = require('express-rate-limit');

const tooMany = { code: 'TOO_MANY_REQUESTS', message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.' };
const mk = (max, windowMs = 15 * 60 * 1000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: tooMany });

const loginLimiter = mk(30);                      // /api/v1/auth/login (khách hàng) - 30 lần / 15 phút / IP
const staffLoginLimiter = mk(30);                 // /api/v1/admin/auth/login (nội bộ) - 30 lần / 15 phút / IP
const registerLimiter = mk(10, 60 * 60 * 1000);   // /api/v1/auth/register - 10 lần / giờ / IP
// Các endpoint bước 1 của đăng nhập / đăng ký (kiểm tra tài khoản + gửi OTP). Mỗi endpoint có bộ đếm riêng.
// Mặc định 20 lần / giờ / IP; đổi bằng OTP_RATE_LIMIT_PER_HOUR (vd. nâng cao khi chạy test tự động).
const otpPerHour = () => Number(process.env.OTP_RATE_LIMIT_PER_HOUR) > 0 ? Number(process.env.OTP_RATE_LIMIT_PER_HOUR) : 20;
const loginIdentifyLimiter = mk(otpPerHour(), 60 * 60 * 1000);  // /api/v1/auth/login/identify
const signupRequestLimiter = mk(otpPerHour(), 60 * 60 * 1000);  // /api/v1/auth/signup/request
const loginVerifyLimiter = mk(Math.max(30, otpPerHour()));       // /api/v1/auth/login/verify  - 30 lần / 15 phút / IP (hoặc OTP_RATE_LIMIT_PER_HOUR nếu lớn hơn)
const signupVerifyLimiter = mk(Math.max(30, otpPerHour()));      // /api/v1/auth/signup/verify - 30 lần / 15 phút / IP (hoặc OTP_RATE_LIMIT_PER_HOUR nếu lớn hơn)

module.exports = { loginLimiter, staffLoginLimiter, registerLimiter, loginIdentifyLimiter, signupRequestLimiter, loginVerifyLimiter, signupVerifyLimiter };
