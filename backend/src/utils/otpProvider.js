// UC-00 Auth - gửi mã OTP qua SMS tới ĐÚNG số điện thoại của khách.
// Mã OTP chỉ đi từ backend -> nhà mạng SMS -> điện thoại. Backend KHÔNG trả mã OTP về web/mobile.
//
// Cấu hình trong .env:
//   OTP_DELIVERY=sms                # bật gửi SMS thật (mặc định: console - chỉ log ở server, dùng khi dev)
//   SMS_PROVIDER=esms | speedsms | twilio   (có thể liệt kê nhiều, cách nhau dấu phẩy, vd. speedsms,esms: thử lần lượt, nhà mạng đầu lỗi thì chuyển sang nhà mạng sau)
//
//   eSMS.vn     : ESMS_API_KEY, ESMS_SECRET_KEY, ESMS_BRANDNAME (tuỳ chọn), ESMS_SMS_TYPE (mặc định 2 = brandname CSKH; 8 = đầu số cố định)
//   SpeedSMS.vn : SPEEDSMS_ACCESS_TOKEN, SPEEDSMS_SENDER (tuỳ chọn), SPEEDSMS_SMS_TYPE (mặc định 2)
//   Twilio      : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  (hoặc TWILIO_MESSAGING_SERVICE_SID)
//
// Node 22 có sẵn fetch nên không cần cài thêm thư viện.

const TTL_MINUTES = 5;

// 0901234567 / +84901234567 / 84901234567 -> 84901234567 (định dạng quốc tế không có dấu +)
function toIntl84(phone) {
  const d = String(phone).replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (d.startsWith('84')) return d;
  if (d.startsWith('0')) return '84' + d.slice(1);
  return d;
}
// 84901234567 -> 0901234567 (định dạng nội địa - eSMS/SpeedSMS nhận cả 2 dạng, dùng 0xxxxxxxxx cho chắc)
const toLocal0 = phone => { const d = toIntl84(phone); return d.startsWith('84') ? '0' + d.slice(2) : d; };

const message = otp => `${otp} la ma xac thuc Vietjet cua ban. Ma het han sau ${TTL_MINUTES} phut. Tuyet doi khong chia se ma nay cho bat ky ai.`;

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

const providers = {
  // https://developers.esms.vn  (API SendMultipleMessage_V4_post_json)
  async esms(phone, otp) {
    const { ESMS_API_KEY, ESMS_SECRET_KEY, ESMS_BRANDNAME, ESMS_SMS_TYPE } = process.env;
    if (!ESMS_API_KEY || !ESMS_SECRET_KEY) throw new Error('Thiếu ESMS_API_KEY / ESMS_SECRET_KEY.');
    const body = { ApiKey: ESMS_API_KEY, SecretKey: ESMS_SECRET_KEY, Phone: toLocal0(phone), Content: message(otp), SmsType: ESMS_SMS_TYPE || '2', IsUnicode: '0' };
    if (ESMS_BRANDNAME) body.Brandname = ESMS_BRANDNAME;
    const { ok, data } = await postJson(process.env.ESMS_API_URL || 'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', body);
    if (!ok || String(data.CodeResult) !== '100') throw new Error(`eSMS lỗi: ${data.CodeResult || ''} ${data.ErrorMessage || data.raw || ''}`.trim());
  },

  // https://speedsms.vn/sms-api-service/
  async speedsms(phone, otp) {
    const { SPEEDSMS_ACCESS_TOKEN, SPEEDSMS_SENDER, SPEEDSMS_SMS_TYPE } = process.env;
    if (!SPEEDSMS_ACCESS_TOKEN) throw new Error('Thiếu SPEEDSMS_ACCESS_TOKEN.');
    const auth = 'Basic ' + Buffer.from(SPEEDSMS_ACCESS_TOKEN + ':x').toString('base64');
    const body = { to: [toLocal0(phone)], content: message(otp), sms_type: Number(SPEEDSMS_SMS_TYPE || 2) };
    if (SPEEDSMS_SENDER) body.sender = SPEEDSMS_SENDER;
    const { ok, data } = await postJson(process.env.SPEEDSMS_API_URL || 'https://api.speedsms.vn/index.php/sms/send', body, { Authorization: auth });
    if (!ok || data.status !== 'success') throw new Error(`SpeedSMS lỗi: ${data.code || ''} ${data.message || data.raw || ''}`.trim());
  },

  // https://www.twilio.com/docs/messaging/api/message-resource
  async twilio(phone, otp) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM, TWILIO_MESSAGING_SERVICE_SID } = process.env;
    if (!sid || !token || !(TWILIO_FROM || TWILIO_MESSAGING_SERVICE_SID)) throw new Error('Thiếu TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM.');
    const form = new URLSearchParams({ To: '+' + toIntl84(phone), Body: message(otp) });
    if (TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', TWILIO_MESSAGING_SERVICE_SID); else form.set('From', TWILIO_FROM);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Twilio lỗi HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  },
};

// OTP_DELIVERY:
//   sms      -> gửi SMS thật qua nhà mạng (SMS_PROVIDER)
//   backend  -> (mặc định) gửi về BACKEND: mã được lưu DB + in ra log server, đồng thời trả `devOtp` trong response
//               để app/web tự hiển thị - dùng khi chưa có tổng đài SMS. KHÔNG dùng khi chạy thật.
//   console  -> chỉ in log server, không trả mã về client
const deliveryMode = () => String(process.env.OTP_DELIVERY || 'backend').toLowerCase();
const exposesOtp = () => deliveryMode() === 'backend';

const maskPhone = phone => { const d = toLocal0(phone); return d.slice(0, 3) + '****' + d.slice(-3); };

async function sendOtp(phone, otp) {
  if (deliveryMode() === 'sms') {
    const names = String(process.env.SMS_PROVIDER || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!names.length) throw new Error(`SMS_PROVIDER chưa được đặt (chọn: ${Object.keys(providers).join(', ')}).`);
    const errors = [];
    for (const name of names) {
      const send = providers[name];
      if (!send) { errors.push(`${name}: không hợp lệ (chọn: ${Object.keys(providers).join(', ')})`); continue; }
      try {
        await send(phone, otp);
        console.log(`[OTP][sms:${name}] đã gửi mã tới ${maskPhone(phone)} (hết hạn sau ${TTL_MINUTES} phút)`);
        return;
      } catch (e) {
        console.error(`[OTP][sms:${name}] thất bại: ${e.message}`);
        errors.push(`${name}: ${e.message}`);
      }
    }
    throw new Error(errors.join(' | '));
  }
  console.log(`[OTP][${deliveryMode()}] ${phone}: ${otp} (hết hạn sau ${TTL_MINUTES} phút)`);
}

module.exports = { sendOtp, exposesOtp, toIntl84, toLocal0 };
