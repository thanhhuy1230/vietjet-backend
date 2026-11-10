// Phát hành vé điện tử (bảng tickets) khi booking được XÁC NHẬN (thanh toán demo hoặc VNPAY).
// Mỗi hành khách × mỗi chặng = 1 vé. Vé là cơ sở cho check-in trực tuyến và đánh giá chuyến bay.
const crypto = require('crypto');

const ticketNo = () => `981${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// exec = client trong transaction. Idempotent: vé đã có thì bỏ qua.
async function issueTickets(exec, bookingId) {
  const { rows } = await exec.query(
    `SELECT bs.segment_id, p.passenger_id, fc.code fare_code, bs.subtotal::float subtotal,
            (SELECT count(*)::int FROM passengers x WHERE x.booking_id=bs.booking_id) pax,
            (SELECT s.seat_code FROM booking_seats s WHERE s.segment_id=bs.segment_id AND s.passenger_id=p.passenger_id AND s.status='ACTIVE' LIMIT 1) seat
       FROM booking_segments bs
       JOIN fare_classes fc ON fc.fare_class_id=bs.fare_class_id
       JOIN passengers p ON p.booking_id=bs.booking_id
      WHERE bs.booking_id=$1
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.segment_id=bs.segment_id AND t.passenger_id=p.passenger_id)`,
    [bookingId]
  );
  for (const r of rows) {
    await exec.query(
      "INSERT INTO tickets(ticket_no,segment_id,passenger_id,status,fare_snapshot) VALUES($1,$2,$3,'ISSUED',$4)",
      [ticketNo(), r.segment_id, r.passenger_id, JSON.stringify({ fareClass: r.fare_code, price: Math.round(r.subtotal / Math.max(1, r.pax)), seat: r.seat || null })]
    );
  }
  return rows.length;
}

module.exports = { issueTickets };
