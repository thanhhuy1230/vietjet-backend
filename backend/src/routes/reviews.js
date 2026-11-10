// Đánh giá chuyến bay phía khách hàng. Chỉ vé của chính khách, chuyến bay đã hạ cánh, mỗi vé 1 lần.
// Admin duyệt/ẩn/phản hồi ở /api/v1/admin/reviews.
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');

const STATUS_LABEL = { PENDING: 'Chờ duyệt', APPROVED: 'Đã duyệt', HIDDEN: 'Đã ẩn', NEEDS_REPLY: 'Cần phản hồi' };

// GET /api/v1/reviews/eligible - các vé đã bay (chuyến đã hạ cánh, booking đã xác nhận) và chưa đánh giá
router.get('/eligible', auth(), async (req, res, next) => {
  try {
    const q = await db.query(`SELECT t.ticket_id "ticketId", t.ticket_no "ticketNo", p.full_name "passengerName", f.flight_no "flightNo",
        ao.iata_code "from", ad.iata_code "to", f.departure_time "departureTime", f.arrival_time "arrivalTime", b.pnr
      FROM tickets t
      JOIN passengers p ON p.passenger_id=t.passenger_id
      JOIN bookings b ON b.booking_id=p.booking_id
      JOIN booking_segments bs ON bs.segment_id=t.segment_id
      JOIN flights f ON f.flight_id=bs.flight_id
      JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id
      WHERE b.user_id=$1 AND b.status='CONFIRMED' AND t.status NOT IN ('CANCELLED','REFUNDED') AND f.arrival_time < now()
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.ticket_id=t.ticket_id)
      ORDER BY f.departure_time DESC`, [req.user.sub]);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

// GET /api/v1/reviews/mine - đánh giá của tôi (kèm trạng thái duyệt + phản hồi của hãng)
router.get('/mine', auth(), async (req, res, next) => {
  try {
    const q = await db.query(`SELECT r.review_id id, r.rating, r.content, r.status, r.admin_reply "adminReply", r.created_at "createdAt",
        t.ticket_no "ticketNo", f.flight_no "flightNo", ao.iata_code "from", ad.iata_code "to", f.departure_time "departureTime"
      FROM reviews r JOIN tickets t ON t.ticket_id=r.ticket_id
      JOIN booking_segments bs ON bs.segment_id=t.segment_id JOIN flights f ON f.flight_id=bs.flight_id
      JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id
      WHERE r.user_id=$1 ORDER BY r.created_at DESC`, [req.user.sub]);
    res.json({ items: q.rows.map((r) => ({ ...r, statusLabel: STATUS_LABEL[r.status] || r.status })) });
  } catch (e) { next(e); }
});

// POST /api/v1/reviews { ticketId, rating 1-5, content }
router.post('/', auth(), async (req, res, next) => {
  try {
    const { ticketId } = req.body || {};
    const rating = Number(req.body?.rating);
    const content = String(req.body?.content || '').trim();
    if (!ticketId) return res.status(422).json({ code: 'VALIDATION', message: 'Vui lòng chọn chuyến bay cần đánh giá.' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(422).json({ code: 'VALIDATION', message: 'Điểm đánh giá từ 1 đến 5.' });
    if (content.length < 10 || content.length > 1000) return res.status(422).json({ code: 'VALIDATION', message: 'Nội dung đánh giá từ 10 đến 1000 ký tự.' });
    const out = await db.tx(async (c) => {
      const t = (await c.query(`SELECT t.ticket_id FROM tickets t JOIN passengers p ON p.passenger_id=t.passenger_id JOIN bookings b ON b.booking_id=p.booking_id
          JOIN booking_segments bs ON bs.segment_id=t.segment_id JOIN flights f ON f.flight_id=bs.flight_id
        WHERE t.ticket_id::text=$2 AND b.user_id=$1 AND b.status='CONFIRMED' AND t.status NOT IN ('CANCELLED','REFUNDED') AND f.arrival_time < now()`, [req.user.sub, String(ticketId)])).rows[0];
      if (!t) throw Object.assign(new Error('Chỉ vé đã hoàn thành chuyến bay của chính bạn mới được đánh giá.'), { status: 422, code: 'REVIEW_NOT_ALLOWED' });
      await c.query("UPDATE tickets SET status='FLOWN', updated_at=now() WHERE ticket_id=$1 AND status IN ('ISSUED','CHECKED_IN')", [t.ticket_id]);
      return (await c.query("INSERT INTO reviews(user_id,ticket_id,rating,content,status) VALUES($1,$2,$3,$4,'PENDING') RETURNING review_id id, rating, content, status, created_at \"createdAt\"", [req.user.sub, t.ticket_id, rating, content])).rows[0];
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ code: 'REVIEW_EXISTS', message: 'Vé này đã được đánh giá.' });
    next(e);
  }
});

module.exports = router;
