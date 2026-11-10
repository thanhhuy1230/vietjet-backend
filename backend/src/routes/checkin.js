// Check-in trực tuyến: tra cứu bằng Mã đặt chỗ (PNR) + Họ hành khách, làm thủ tục cho từng vé, phát hành thẻ lên máy bay.
// Dữ liệu: tickets, check_ins, boarding_passes, booking_seats (ghế chưa chọn sẽ được hệ thống tự xếp lúc check-in).
// Cửa sổ check-in: mở trước giờ bay CHECKIN_OPEN_HOURS giờ (mặc định 24), đóng trước CHECKIN_CLOSE_MINUTES phút (mặc định 60).
const crypto = require('crypto');
const router = require('express').Router();
const db = require('../db');
const { describeSeat, releaseStale, isBusinessFareCode } = require('../utils/seats');

const openHours = () => Number(process.env.CHECKIN_OPEN_HOURS ?? 24);
const closeMinutes = () => Number(process.env.CHECKIN_CLOSE_MINUTES ?? 60);
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').trim().toUpperCase();
const barcode = (checkInId) => crypto.createHmac('sha256', process.env.JWT_SECRET || 'vj').update(String(checkInId)).digest('hex').slice(0, 24).toUpperCase();
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });

function windowReason(departure, now = new Date()) {
  const dep = new Date(departure).getTime(), t = now.getTime();
  if (dep - t > openHours() * 3600000) return `Check-in trực tuyến mở trước giờ khởi hành ${openHours()} giờ (từ ${new Date(dep - openHours() * 3600000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}).`;
  if (dep - t < closeMinutes() * 60000) return `Đã đóng check-in trực tuyến (đóng trước giờ bay ${closeMinutes()} phút).`;
  return '';
}

async function loadTickets(exec, pnr, lastName) {
  const b = (await exec.query("SELECT booking_id, pnr, status FROM bookings WHERE upper(pnr)=upper($1)", [String(pnr || '').trim()])).rows[0];
  if (!b) throw httpErr(404, 'BOOKING_NOT_FOUND', 'Không tìm thấy đặt chỗ. Vui lòng kiểm tra lại mã đặt chỗ và họ hành khách.');
  const rows = (await exec.query(`SELECT t.ticket_id "ticketId", t.ticket_no "ticketNo", t.status "ticketStatus", t.segment_id "segmentId", p.passenger_id "passengerId", p.full_name "passengerName",
        f.flight_id "flightId", f.flight_no "flightNo", f.status "flightStatus", f.departure_time "departureTime", f.arrival_time "arrivalTime",
        ao.iata_code "from", ao.city "fromCity", ad.iata_code "to", ad.city "toCity", fc.code "fareCode", fc.name "fareName",
        (SELECT s.seat_code FROM booking_seats s WHERE s.segment_id=t.segment_id AND s.passenger_id=t.passenger_id AND s.status='ACTIVE' LIMIT 1) seat,
        ci.check_in_id "checkInId", ci.checked_in_at "checkedInAt", bp.gate, bp.boarding_time "boardingTime"
      FROM tickets t JOIN passengers p ON p.passenger_id=t.passenger_id
      JOIN booking_segments bs ON bs.segment_id=t.segment_id JOIN flights f ON f.flight_id=bs.flight_id
      JOIN fare_classes fc ON fc.fare_class_id=bs.fare_class_id
      JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id
      LEFT JOIN check_ins ci ON ci.ticket_id=t.ticket_id LEFT JOIN boarding_passes bp ON bp.check_in_id=ci.check_in_id
      WHERE p.booking_id=$1 ORDER BY f.departure_time, p.full_name`, [b.booking_id])).rows;
  const ln = fold(lastName);
  const mine = rows.filter((r) => { const parts = fold(r.passengerName).split(/\s+/); return ln && (parts[0] === ln || parts[parts.length - 1] === ln || fold(r.passengerName) === ln); });
  if (!mine.length) throw httpErr(404, 'BOOKING_NOT_FOUND', 'Không tìm thấy đặt chỗ. Vui lòng kiểm tra lại mã đặt chỗ và họ hành khách.');
  if (b.status !== 'CONFIRMED') throw httpErr(409, 'BOOKING_NOT_CONFIRMED', 'Đặt chỗ chưa được thanh toán / xác nhận nên chưa thể check-in.');
  return { booking: b, tickets: mine };
}

const present = (r) => {
  let reason = '';
  if (r.checkInId) reason = '';
  else if (['CANCELLED', 'REFUNDED'].includes(r.ticketStatus)) reason = 'Vé đã hủy.';
  else if (r.flightStatus === 'CANCELLED') reason = 'Chuyến bay đã bị hủy.';
  else reason = windowReason(r.departureTime);
  return { ...r, checkedIn: !!r.checkInId, canCheckin: !r.checkInId && !reason, reason,
    boardingPass: r.checkInId ? { barcode: barcode(r.checkInId), seat: r.seat, gate: r.gate, boardingTime: r.boardingTime } : null };
};

// POST /api/v1/checkin/lookup { pnr, lastName }
router.post('/lookup', async (req, res, next) => {
  try {
    const { booking, tickets } = await loadTickets(db, req.body?.pnr, req.body?.lastName);
    res.json({ pnr: booking.pnr, tickets: tickets.map(present), rules: { openHours: openHours(), closeMinutes: closeMinutes() } });
  } catch (e) { next(e); }
});

// Tự xếp ghế còn trống đúng khoang khi khách chưa chọn ghế lúc đặt vé
async function autoSeat(c, t) {
  await releaseStale(c, t.flightId, null, null);
  const taken = new Set((await c.query("SELECT seat_code FROM booking_seats WHERE flight_id=$1 AND status='ACTIVE'", [t.flightId])).rows.map((r) => r.seat_code));
  const rows = isBusinessFareCode(t.fareCode) ? [1, 2, 3] : [5, 6, 7, 8, 9, 10, 11];
  const cols = isBusinessFareCode(t.fareCode) ? ['A', 'C', 'D', 'F'] : ['A', 'B', 'C', 'D', 'E', 'F'];
  for (const r of rows) for (const col of cols) {
    const code = `${r}${col}`;
    if (taken.has(code)) continue;
    const info = describeSeat(code, t.fareCode);
    const bk = (await c.query('SELECT booking_id FROM booking_segments WHERE segment_id=$1', [t.segmentId])).rows[0];
    await c.query("INSERT INTO booking_seats(booking_id,segment_id,passenger_id,flight_id,seat_code,seat_type,price) VALUES($1,$2,$3,$4,$5,$6,0)", [bk.booking_id, t.segmentId, t.passengerId, t.flightId, info.code, info.type]);
    return info.code;
  }
  return null;
}

// POST /api/v1/checkin { pnr, lastName, ticketIds:[...] } - làm thủ tục cho các vé được chọn (bỏ trống = tất cả vé đủ điều kiện)
router.post('/', async (req, res, next) => {
  try {
    const out = await db.tx(async (c) => {
      const { booking, tickets } = await loadTickets(c, req.body?.pnr, req.body?.lastName);
      const wanted = Array.isArray(req.body?.ticketIds) && req.body.ticketIds.length ? new Set(req.body.ticketIds.map(String)) : null;
      const list = tickets.map(present).filter((t) => !wanted || wanted.has(String(t.ticketId)));
      if (!list.length) throw httpErr(422, 'VALIDATION', 'Vui lòng chọn vé cần check-in.');
      const blocked = list.find((t) => !t.checkedIn && !t.canCheckin);
      if (blocked) throw httpErr(409, 'CHECKIN_NOT_ALLOWED', `${blocked.flightNo} - ${blocked.passengerName}: ${blocked.reason}`);
      for (const t of list.filter((x) => !x.checkedIn)) {
        if (!t.seat) t.seat = await autoSeat(c, t);
        const ci = (await c.query("INSERT INTO check_ins(ticket_id,channel,status) VALUES($1,'ONLINE','COMPLETED') RETURNING check_in_id", [t.ticketId])).rows[0];
        await c.query("INSERT INTO boarding_passes(check_in_id,barcode_token_hash,gate,boarding_time) VALUES($1,$2,NULL,$3::timestamptz - interval '40 minutes')",
          [ci.check_in_id, crypto.createHash('sha256').update(barcode(ci.check_in_id)).digest('hex'), t.departureTime]);
        await c.query("UPDATE tickets SET status='CHECKED_IN', updated_at=now() WHERE ticket_id=$1", [t.ticketId]);
      }
      return (await loadTickets(c, booking.pnr, req.body?.lastName)).tickets.map(present);
    });
    res.json({ tickets: out });
  } catch (e) { next(e); }
});

module.exports = router;
