// Gửi thử 1 tin nhắn SMS để kiểm tra khoá eSMS / SpeedSMS đã đúng chưa (không cần mở app).
//   npm run test:sms -- 0384837357
// Dùng đúng cấu hình trong .env (SMS_PROVIDER, ESMS_*, SPEEDSMS_*), luôn gửi SMS thật (bất kể OTP_DELIVERY).
// Mỗi tin trừ tiền tài khoản SMS của bạn - đừng chạy lặp lại không cần thiết.
require('dotenv').config();
const crypto = require('crypto');
process.env.OTP_DELIVERY = 'sms';
const { sendOtp, toLocal0 } = require('./utils/otpProvider');

const phone = process.argv[2];
if (!phone || !/^(\+?84|0)\d{9}$/.test(phone.replace(/[\s.-]/g, ''))) {
  console.error('Cách dùng: npm run test:sms -- <số điện thoại>   vd. npm run test:sms -- 0384837357');
  process.exit(1);
}

(async () => {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  console.log(`Nhà mạng thử theo thứ tự: ${process.env.SMS_PROVIDER || '(chưa đặt SMS_PROVIDER)'}`);
  console.log(`Gửi mã thử ${code} tới ${toLocal0(phone)} ...`);
  try {
    await sendOtp(phone, code);
    console.log('OK - nhà mạng đã nhận yêu cầu. Kiểm tra điện thoại (có thể mất vài giây đến 1-2 phút).');
  } catch (e) {
    console.error('THẤT BẠI:', e.message);
    console.error('Gợi ý: kiểm tra số dư tài khoản, khoá API, và loại tin (ESMS_SMS_TYPE / SPEEDSMS_SMS_TYPE) trong .env.');
    process.exit(2);
  }
})();
