// Chuyển trạng thái booking dùng chung cho thanh toán demo, VNPAY và hủy vé:
//  - confirmBooking: CONFIRMED + phát hành vé + trừ số chỗ còn bán (flight_fares.quota, flight_inventory.available_seats)
//  - restoreInventory: trả lại chỗ khi hủy một booking đã xác nhận
const { issueTickets } = require('./tickets');
const loyalty = require('./loyalty');

async function adjustInventory(exec, bookingId, sign) {
  const pax = (await exec.query('SELECT count(*)::int n FROM passengers WHERE booking_id=$1', [bookingId])).rows[0].n;
  if (!pax) return;
  const delta = sign * pax;
  await exec.query(
    `UPDATE flight_fares ff SET quota=greatest(0, ff.quota + $2)
       FROM booking_segments bs WHERE bs.booking_id=$1 AND ff.flight_id=bs.flight_id AND ff.fare_class_id=bs.fare_class_id`,
    [bookingId, delta]
  );
  await exec.query(
    `UPDATE flight_inventory fi SET available_seats=greatest(0, fi.available_seats + $2), version=fi.version+1, updated_at=now()
       FROM booking_segments bs WHERE bs.booking_id=$1 AND fi.flight_id=bs.flight_id`,
    [bookingId, delta]
  );
}

async function confirmBooking(exec, bookingId) {
  const r = await exec.query("UPDATE bookings SET status='CONFIRMED',confirmed_at=now(),updated_at=now() WHERE booking_id=$1 AND status='PENDING_PAYMENT' RETURNING booking_id", [bookingId]);
  if (!r.rowCount) return false;
  await adjustInventory(exec, bookingId, -1);
  await issueTickets(exec, bookingId);
  await loyalty.onBookingConfirmed(exec, bookingId); // SkyJoy: trừ hẳn điểm đã dùng + ghi điểm tích lũy chờ cộng
  return true;
}

const restoreInventory = (exec, bookingId) => adjustInventory(exec, bookingId, +1);

module.exports = { confirmBooking, restoreInventory };
