// Tích hợp cổng thanh toán VNPAY (paymentv2 / vpcpay.html).
// Toàn bộ cấu hình lấy từ biến môi trường (.env) - đổi domain/return URL chỉ cần sửa .env, không sửa code:
//   VNPAY_PAYMENT_URL      URL cổng thanh toán (sandbox: http://sandbox.vnpayment.vn/paymentv2/vpcpay.html)
//   VNPAY_RETURN_URL       URL VNPAY redirect khách về sau khi thanh toán (đường dẫn phải khớp route callback của backend)
//   VNPAY_RETURN_URL_CARGO URL return riêng cho luồng đơn hàng/cargo (order-bill/confirmation) - app vé máy bay chưa dùng
//   VNPAY_HASH_SECRET      chuỗi bí mật ký HMAC-SHA512
//   VNPAY_BRAND_CODE       mã website/merchant (vnp_TmnCode)
//   VNPAY_CURRENCY=VND, VNPAY_VERSION=2.0.0
const crypto = require('crypto');

// Sandbox VNPAY chỉ nhận HTTPS ổn định -> tự nâng http://sandbox.vnpayment.vn lên https.
const fixUrl = u => String(u || '').replace(/^http:\/\/(sandbox\.vnpayment\.vn)/i, 'https://$1');

const cfg = () => ({
  paymentUrl: fixUrl(process.env.VNPAY_PAYMENT_URL) || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: process.env.VNPAY_RETURN_URL,
  returnUrlCargo: process.env.VNPAY_RETURN_URL_CARGO,
  secret: process.env.VNPAY_HASH_SECRET,
  tmnCode: process.env.VNPAY_BRAND_CODE,
  currency: process.env.VNPAY_CURRENCY || 'VND',
  version: process.env.VNPAY_VERSION || '2.1.0', // ký HMAC-SHA512 chỉ hợp lệ với phiên bản 2.1.0 trở lên
  secureHashType: process.env.VNPAY_SECURE_HASH_TYPE || '', // để trống = không gửi vnp_SecureHashType
  expireMinutes: Number(process.env.VNPAY_EXPIRE_MINUTES || 15),
});

function isConfigured() { const c = cfg(); return !!(c.paymentUrl && c.secret && c.tmnCode); }

// Đường dẫn (pathname) của VNPAY_RETURN_URL -> backend đăng ký route callback đúng đường dẫn này,
// nên khi đổi sang domain khác chỉ cần đổi VNPAY_RETURN_URL trong .env.
function returnPath() {
  try { return new URL(process.env.VNPAY_RETURN_URL).pathname; } catch { return '/payment/vnpay/callback'; }
}

// Return URL gửi sang VNPAY. Nếu VNPAY_RETURN_URL để trống / 'auto' (hoặc trỏ tới host không phải của server này khi chạy local)
// thì tự dựng từ chính địa chỉ mà client đang gọi API (vd. http://localhost:3000 hoặc http://192.168.1.10:3000), để khách
// luôn được VNPAY chuyển về ĐÚNG backend này và booking được xác nhận.
function resolveReturnUrl(req) {
  const env = String(process.env.VNPAY_RETURN_URL || '').trim();
  if (env && env.toLowerCase() !== 'auto') return env;
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  return base + returnPath();
}

// yyyyMMddHHmmss theo giờ Việt Nam (GMT+7) - định dạng bắt buộc của VNPAY
function vnTime(d = new Date()) {
  const p = new Date(d.getTime() + 7 * 3600 * 1000).toISOString(); // 2026-09-28T10:11:12.000Z (đã cộng 7h)
  return p.slice(0, 19).replace(/[-:T]/g, '');
}

const enc = v => encodeURIComponent(v).replace(/%20/g, '+');

// Chuỗi dữ liệu cần ký: key sắp xếp A-Z, "key=value" (value đã URL-encode, khoảng trắng -> +), nối bằng &
function buildQuery(params) {
  return Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '').sort()
    .map(k => `${enc(k)}=${enc(String(params[k]))}`).join('&');
}
const sign = (data, secret) => crypto.createHmac('sha512', secret).update(Buffer.from(data, 'utf-8')).digest('hex');

// Bỏ dấu tiếng Việt + ký tự đặc biệt: vnp_OrderInfo phải là tiếng Việt không dấu
const ascii = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9 .,_-]/g, ' ').replace(/\s+/g, ' ').trim();

function buildPaymentUrl({ txnRef, amountVnd, orderInfo, ipAddr, bankCode, locale = 'vn', returnUrl, now = new Date() }) {
  const c = cfg();
  const params = {
    vnp_Version: c.version, vnp_Command: 'pay', vnp_TmnCode: c.tmnCode,
    vnp_Amount: Math.round(amountVnd) * 100, // VNPAY yêu cầu nhân 100
    vnp_CurrCode: c.currency, vnp_TxnRef: txnRef, vnp_OrderInfo: ascii(orderInfo), vnp_OrderType: 'other',
    vnp_Locale: locale === 'en' ? 'en' : 'vn', vnp_ReturnUrl: returnUrl || c.returnUrl, vnp_IpAddr: ipAddr || '127.0.0.1',
    vnp_CreateDate: vnTime(now), vnp_ExpireDate: vnTime(new Date(now.getTime() + c.expireMinutes * 60000)),
  };
  if (bankCode) params.vnp_BankCode = bankCode;
  const query = buildQuery(params);
  let url = `${c.paymentUrl}?${query}&vnp_SecureHash=${sign(query, c.secret)}`;
  if (c.secureHashType) url += `&vnp_SecureHashType=${encodeURIComponent(c.secureHashType)}`; // không nằm trong chuỗi ký
  return url;
}

// Kiểm tra chữ ký của dữ liệu VNPAY gửi về (return URL hoặc IPN). query = req.query (đã decode).
function verify(query) {
  const c = cfg();
  const got = String(query.vnp_SecureHash || '').toLowerCase();
  if (!got || !c.secret) return false;
  const params = {};
  for (const [k, v] of Object.entries(query)) if (k.startsWith('vnp_') && k !== 'vnp_SecureHash' && k !== 'vnp_SecureHashType') params[k] = Array.isArray(v) ? v[0] : v;
  const expected = sign(buildQuery(params), c.secret);
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const RESPONSE_MESSAGES = {
  '00': 'Giao dịch thành công.',
  '07': 'Giao dịch bị nghi ngờ gian lận / bất thường.',
  '09': 'Thẻ/tài khoản chưa đăng ký dịch vụ Internet Banking.',
  '10': 'Xác thực thông tin thẻ/tài khoản sai quá 3 lần.',
  '11': 'Đã hết hạn chờ thanh toán. Vui lòng thực hiện lại giao dịch.',
  '12': 'Thẻ/tài khoản đang bị khóa.',
  '13': 'Nhập sai mật khẩu xác thực giao dịch (OTP).',
  '24': 'Bạn đã hủy giao dịch.',
  '51': 'Tài khoản không đủ số dư.',
  '65': 'Tài khoản đã vượt hạn mức giao dịch trong ngày.',
  '75': 'Ngân hàng đang bảo trì.',
  '79': 'Nhập sai mật khẩu thanh toán quá số lần quy định.',
  '99': 'Lỗi khác từ VNPAY.',
};
const messageFor = code => RESPONSE_MESSAGES[code] || 'Thanh toán không thành công.';

// vnp_IpAddr: bỏ tiền tố IPv6-mapped ::ffff:
const clientIp = req => String(req.ip || req.socket?.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');

module.exports = { cfg, isConfigured, returnPath, resolveReturnUrl, buildPaymentUrl, buildQuery, sign, verify, messageFor, clientIp, vnTime, ascii };
