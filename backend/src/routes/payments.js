// Thanh toán VNPAY cho booking.
//   POST /api/v1/payments/vnpay/create   (đăng nhập) - tạo giao dịch PENDING + trả về paymentUrl để redirect sang VNPAY
//   GET  /api/v1/payments/vnpay/ipn      (VNPAY gọi server-to-server) - nguồn xác nhận chính thức, trả {RspCode, Message}
//   GET  <đường dẫn của VNPAY_RETURN_URL> (khách được VNPAY redirect về, mặc định /payment/vnpay/callback)
//        - kiểm tra chữ ký, cập nhật trạng thái (idempotent, dùng chung logic với IPN) rồi chuyển khách về trang kết quả.
//   GET  /api/v1/payments/vnpay/status/:bookingId (đăng nhập) - app mobile hỏi lại trạng thái sau khi quay lại từ VNPAY.
const crypto = require('crypto');
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const vnpay = require('../utils/vnpay');
const { confirmBooking } = require('../utils/bookingState');

const BANK_CODES = new Set(['', 'VNPAYQR', 'VNBANK', 'INTCARD']);

router.post('/vnpay/create', auth(), async (req, res, next) => {
  try {
    if (!vnpay.isConfigured()) return res.status(503).json({ code: 'VNPAY_NOT_CONFIGURED', message: 'Cổng VNPAY chưa được cấu hình trên máy chủ.' });
    const { bookingId, bankCode = '', locale, client } = req.body || {};
    if (!bookingId) return res.status(422).json({ code: 'VALIDATION', message: 'Thiếu bookingId.' });
    if (!BANK_CODES.has(bankCode)) return res.status(422).json({ code: 'VALIDATION', message: 'bankCode không hợp lệ.' });

    const out = await db.tx(async c => {
      const b = (await c.query('SELECT booking_id,pnr,status,total_amount,expires_at FROM bookings WHERE booking_id=$1 AND user_id=$2 FOR UPDATE', [bookingId, req.user.sub])).rows[0];
      if (!b) throw Object.assign(new Error('Không tìm thấy booking.'), { status: 404, code: 'BOOKING_NOT_FOUND' });
      if (b.status !== 'PENDING_PAYMENT') throw Object.assign(new Error('Booking không ở trạng thái chờ thanh toán.'), { status: 409, code: 'BOOKING_NOT_PAYABLE' });
      if (b.expires_at && new Date(b.expires_at) <= new Date()) throw Object.assign(new Error('Booking đã hết thời gian giữ chỗ, vui lòng đặt lại.'), { status: 409, code: 'BOOKING_EXPIRED' });
      if (!(+b.total_amount > 0)) throw Object.assign(new Error('Số tiền thanh toán không hợp lệ.'), { status: 409, code: 'INVALID_AMOUNT' });

      // Mỗi lần bấm thanh toán = 1 mã giao dịch mới (vnp_TxnRef phải duy nhất). Huỷ các giao dịch PENDING cũ của booking này.
      await c.query("UPDATE payments SET status='CANCELLED' WHERE booking_id=$1 AND provider='VNPAY' AND status='PENDING'", [b.booking_id]);
      const txnRef = `${b.pnr}${Date.now().toString(36).toUpperCase()}${crypto.randomInt(0, 36 ** 3).toString(36).toUpperCase()}`;
      await c.query("INSERT INTO payments(booking_id,provider,amount,status,idempotency_key) VALUES($1,'VNPAY',$2,'PENDING',$3)", [b.booking_id, b.total_amount, txnRef]);
      return { b, txnRef };
    });

    const paymentUrl = vnpay.buildPaymentUrl({
      txnRef: out.txnRef, amountVnd: +out.b.total_amount, ipAddr: vnpay.clientIp(req), bankCode,
      orderInfo: `Thanh toan ve may bay ${out.b.pnr}`, locale, returnUrl: vnpay.resolveReturnUrl(req) + (client === 'app' ? '?src=app' : ''),
    });
    res.json({ paymentUrl, txnRef: out.txnRef, bookingId: out.b.booking_id, pnr: out.b.pnr });
  } catch (e) { next(e); }
});

// Áp kết quả VNPAY lên DB. Idempotent: gọi nhiều lần (return + IPN + F5) cho cùng giao dịch chỉ xử lý 1 lần.
// Trả về { rsp: {RspCode,Message} cho IPN, ok: đã thanh toán?, pnr, bookingId, message, alreadyProcessed }
async function applyVnpayResult(q) {
  if (!vnpay.verify(q)) return { rsp: { RspCode: '97', Message: 'Invalid signature' }, ok: false, message: 'Chữ ký không hợp lệ.' };
  const txnRef = q.vnp_TxnRef;
  const respCode = q.vnp_ResponseCode, txnStatus = q.vnp_TransactionStatus;
  const success = respCode === '00' && (txnStatus === undefined || txnStatus === '00');

  return db.tx(async c => {
    const p = (await c.query("SELECT p.payment_id,p.booking_id,p.amount,p.status,b.pnr,b.status booking_status,b.user_id FROM payments p JOIN bookings b ON b.booking_id=p.booking_id WHERE p.idempotency_key=$1 AND p.provider='VNPAY' FOR UPDATE OF p", [txnRef])).rows[0];
    if (!p) return { rsp: { RspCode: '01', Message: 'Order not found' }, ok: false, message: 'Không tìm thấy giao dịch.' };
    if (Math.round(+p.amount) * 100 !== Number(q.vnp_Amount)) return { rsp: { RspCode: '04', Message: 'Invalid amount' }, ok: false, pnr: p.pnr, message: 'Số tiền không khớp.' };
    if (p.status !== 'PENDING') {
      return { rsp: { RspCode: '02', Message: 'Order already confirmed' }, ok: p.status === 'SUCCEEDED', pnr: p.pnr, bookingId: p.booking_id, alreadyProcessed: true,
        message: p.status === 'SUCCEEDED' ? 'Thanh toán thành công.' : vnpay.messageFor(respCode) };
    }

    const eventId = `vnpay:${txnRef}:${q.vnp_TransactionNo || respCode}`;
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(q).filter(([k]) => k.startsWith('vnp_')).sort()))).digest('hex');
    await c.query('INSERT INTO payment_events(payment_id,provider_event_id,payload_hash,status) VALUES($1,$2,$3,$4) ON CONFLICT (provider_event_id) DO NOTHING', [p.payment_id, eventId, payloadHash, success ? 'SUCCEEDED' : 'FAILED']);

    if (!success) {
      await c.query("UPDATE payments SET status='FAILED' WHERE payment_id=$1", [p.payment_id]);
      // Booking vẫn PENDING_PAYMENT: khách có thể thanh toán lại cho tới khi hết hạn giữ chỗ.
      return { rsp: { RspCode: '00', Message: 'Confirm Success' }, ok: false, pnr: p.pnr, bookingId: p.booking_id, message: vnpay.messageFor(respCode) };
    }

    await c.query("UPDATE payments SET status='SUCCEEDED' WHERE payment_id=$1", [p.payment_id]);
    if (p.booking_status === 'PENDING_PAYMENT') {
      await confirmBooking(c, p.booking_id); // CONFIRMED + phát hành vé + trừ chỗ còn bán
      await c.query("INSERT INTO notifications(user_id,booking_id,type,title,body,status,sent_at) VALUES($1,$2,'BOOKING_CONFIRMED','Đặt vé thành công',$3,'SENT',now())", [p.user_id, p.booking_id, `Booking ${p.pnr} đã được thanh toán qua VNPAY và xác nhận.`]);
    } else if (p.booking_status !== 'CONFIRMED') {
      // Khách đã trả tiền nhưng booking đã bị huỷ/hết hạn trong lúc thanh toán -> tạo yêu cầu hoàn tiền cho bộ phận vận hành.
      await c.query("INSERT INTO refund_requests(booking_id,payment_id,amount,fee,status) VALUES($1,$2,$3,0,'REQUESTED')", [p.booking_id, p.payment_id, p.amount]);
    }
    return { rsp: { RspCode: '00', Message: 'Confirm Success' }, ok: true, pnr: p.pnr, bookingId: p.booking_id, message: 'Thanh toán thành công.' };
  });
}

router.get('/vnpay/ipn', async (req, res) => {
  try { res.json((await applyVnpayResult(req.query)).rsp); }
  catch (e) { console.error('[VNPAY IPN]', e); res.json({ RspCode: '99', Message: 'Unknown error' }); }
});

router.get('/vnpay/status/:bookingId', auth(), async (req, res, next) => {
  try {
    const r = (await db.query(`SELECT b.status booking_status,b.pnr,
        (SELECT p.status FROM payments p WHERE p.booking_id=b.booking_id AND p.provider='VNPAY' ORDER BY p.created_at DESC LIMIT 1) payment_status
      FROM bookings b WHERE b.booking_id=$1 AND b.user_id=$2`, [req.params.bookingId, req.user.sub])).rows[0];
    if (!r) return res.status(404).json({ code: 'BOOKING_NOT_FOUND', message: 'Không tìm thấy booking.' });
    res.json({ pnr: r.pnr, bookingStatus: r.booking_status, paymentStatus: r.payment_status, paid: r.payment_status === 'SUCCEEDED' && r.booking_status === 'CONFIRMED' });
  } catch (e) { next(e); }
});

// Khách được VNPAY redirect về đây (đường dẫn = pathname của VNPAY_RETURN_URL). Xử lý rồi chuyển về giao diện web.
async function returnHandler(req, res) {
  let r;
  try { r = await applyVnpayResult(req.query); }
  catch (e) { console.error('[VNPAY return]', e); r = { ok: false, message: 'Có lỗi khi xử lý kết quả thanh toán.' }; }
  // Thanh toán khởi tạo từ app mobile (?src=app): hiện trang kết quả gọn, app tự hỏi lại backend để cập nhật vé.
  if (req.query.src === 'app') {
    const esc = t => String(t || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const color = r.ok ? '#15a34a' : '#e4002b';
    return res.status(200).type('html').send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kết quả thanh toán</title></head>
<body style="font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#fff;border-radius:18px;padding:32px 24px;max-width:380px;margin:16px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.08)">
<div style="font-size:54px;color:${color}">${r.ok ? '✓' : '✕'}</div>
<h2 style="margin:8px 0">${r.ok ? 'Thanh toán thành công' : 'Thanh toán chưa hoàn tất'}</h2>
${r.pnr ? `<p style="margin:4px 0;color:#6b7280">Mã đặt chỗ</p><p style="font-size:26px;letter-spacing:3px;font-weight:800;margin:4px 0 12px">${esc(r.pnr)}</p>` : ''}
<p style="color:#6b7280">${esc(r.message)}</p>
<p style="margin-top:20px">Vui lòng quay lại ứng dụng Vietjet để xem vé.</p></div></body></html>`);
  }
  const qs = new URLSearchParams({ vnpay_status: r.ok ? 'success' : 'failed', msg: r.message || '' });
  if (r.pnr) qs.set('pnr', r.pnr);
  const webUrl = String(process.env.WEB_URL || '').replace(/\/+$/, '');
  res.redirect(302, `${webUrl}/?${qs.toString()}`);
}

module.exports = { router, returnHandler, applyVnpayResult };
