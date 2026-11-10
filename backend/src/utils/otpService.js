// Dịch vụ OTP dùng chung cho đăng nhập ('login'), đăng ký ('signup') và đổi số điện thoại ('change_phone', OTP gửi tới SỐ MỚI).
// - Mỗi OTP gắn với (phone, purpose): OTP của luồng này KHÔNG dùng được cho luồng kia.
// - OTP chỉ lưu dạng hash sha256, dùng 1 lần, hết hạn sau 5 phút, tối đa 5 lần nhập sai, cách nhau 60s mỗi lần gửi.
// - Gửi SMS qua utils/otpProvider.js (eSMS / SpeedSMS / ...). OTP_DELIVERY=backend: trả kèm devOtp để test, không gửi SMS.
const crypto = require('crypto');
const db = require('../db');
const { sendOtp, exposesOtp } = require('./otpProvider');

const OTP_TTL_MINUTES = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const PURPOSES = ['login', 'signup', 'change_phone'];

const hashOtp = otp => crypto.createHash('sha256').update(String(otp)).digest('hex');
const sameHash = (a, b) => {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const assertPurpose = purpose => { if (!PURPOSES.includes(purpose)) throw new Error(`OTP purpose không hợp lệ: ${purpose}`); };

// Tạo + gửi OTP. Trả { ok:true, body } hoặc { ok:false, status, body } để route trả thẳng cho client.
async function issueOtp(phone, purpose) {
  assertPurpose(purpose);

  // Khoá theo (purpose, phone) trong transaction: 2 yêu cầu song song không thể cùng vượt qua kiểm tra cooldown (tránh gửi 2 SMS = tốn tiền).
  const created = await db.tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp:${purpose}:${phone}`]);
    const recent = (await c.query(
      'SELECT created_at FROM phone_otps WHERE phone=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',
      [phone, purpose]
    )).rows[0];
    if (recent) {
      const waitMs = OTP_RESEND_COOLDOWN_SECONDS * 1000 - (Date.now() - new Date(recent.created_at).getTime());
      if (waitMs > 0) return { cooldown: Math.ceil(waitMs / 1000) };
    }
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const row = (await c.query(
      "INSERT INTO phone_otps(phone,purpose,otp_hash,expires_at) VALUES($1,$2,$3,now()+($4||' minutes')::interval) RETURNING otp_id",
      [phone, purpose, hashOtp(otp), OTP_TTL_MINUTES]
    )).rows[0];
    return { otp, otpId: row.otp_id };
  });

  if (created.cooldown) {
    return {
      ok: false, status: 429,
      body: { code: 'OTP_COOLDOWN', message: `Vui lòng đợi ${created.cooldown}s trước khi gửi lại mã.`, retryAfterSeconds: created.cooldown },
    };
  }

  try {
    await sendOtp(phone, created.otp);
  } catch (err) {
    console.error('[OTP] Gửi SMS thất bại:', err.message);
    await db.query('DELETE FROM phone_otps WHERE otp_id=$1', [created.otpId]); // không giữ mã chưa gửi được (và không khoá cooldown)
    return { ok: false, status: 502, body: { code: 'SMS_SEND_FAILED', message: 'Không gửi được tin nhắn SMS, vui lòng thử lại sau ít phút.' } };
  }

  // Chỉ 1 mã hợp lệ tại một thời điểm: gửi mã mới thành công thì các mã cũ chưa dùng của (phone, purpose) hết hiệu lực.
  await db.query('UPDATE phone_otps SET consumed_at=now() WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL AND otp_id<>$3', [phone, purpose, created.otpId]);

  const body = { otpSent: true, cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  if (exposesOtp()) { // chỉ khi OTP_DELIVERY=backend (môi trường phát triển): trả mã để màn hình hiển thị, KHÔNG dùng khi chạy thật
    body.delivery = 'backend';
    body.devOtp = created.otp;
  } else {
    body.delivery = 'sms';
  }
  return { ok: true, body };
}

// Kiểm tra OTP mới nhất chưa dùng của (phone, purpose). Đúng -> đánh dấu đã dùng (nguyên tử, chỉ 1 request thắng).
// Trả { ok:true } hoặc { ok:false, status:401, body:{code:OTP_EXPIRED|OTP_LOCKED|OTP_INVALID,...} }.
async function verifyOtp(phone, purpose, otp) {
  assertPurpose(purpose);
  const row = (await db.query(
    'SELECT otp_id,otp_hash,attempts,expires_at FROM phone_otps WHERE phone=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [phone, purpose]
  )).rows[0];

  if (!row || new Date(row.expires_at) < new Date()) {
    return { ok: false, status: 401, body: { code: 'OTP_EXPIRED', message: 'Mã OTP đã hết hạn, vui lòng gửi lại mã.' } };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, status: 401, body: { code: 'OTP_LOCKED', message: 'Bạn đã nhập sai quá nhiều lần, vui lòng gửi lại mã mới.' } };
  }
  if (!sameHash(row.otp_hash, hashOtp(otp))) {
    await db.query('UPDATE phone_otps SET attempts=attempts+1 WHERE otp_id=$1', [row.otp_id]);
    return { ok: false, status: 401, body: { code: 'OTP_INVALID', message: 'Mã OTP không đúng.', remainingAttempts: Math.max(0, OTP_MAX_ATTEMPTS - row.attempts - 1) } };
  }
  const used = await db.query('UPDATE phone_otps SET consumed_at=now() WHERE otp_id=$1 AND consumed_at IS NULL RETURNING otp_id', [row.otp_id]);
  if (!used.rowCount) { // request song song khác đã dùng mã này
    return { ok: false, status: 401, body: { code: 'OTP_EXPIRED', message: 'Mã OTP đã được sử dụng, vui lòng gửi lại mã.' } };
  }
  return { ok: true };
}

module.exports = { issueOtp, verifyOtp, hashOtp, OTP_TTL_MINUTES, OTP_RESEND_COOLDOWN_SECONDS, OTP_MAX_ATTEMPTS };
