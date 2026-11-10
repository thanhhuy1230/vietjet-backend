// Sơ đồ ghế + khóa ghế theo chuyến bay.
// LƯU Ý: bố cục ghế và giá ghế phải KHỚP với vietjet-customer/src/data/seatmap.js (app dùng để vẽ sơ đồ).
//
// Quy tắc (giống các hãng bay Việt Nam - máy bay nội địa có 2 khoang, khoang do HẠNG VÉ quyết định):
//   - Vé SkyBoss (Business): khoang Thương gia, hàng 1-3, bố trí 2-2 (cột A,C,D,F), ghế đã gồm trong giá vé.
//   - Vé Eco/Deluxe: khoang Phổ thông, hàng 4-12, bố trí 3-3 (cột A-F). Ghế thường 90.000đ; hàng đầu (4) và hàng rộng chân (12) 150.000đ.
const ALL_COLS = ['A', 'B', 'C', 'D', 'E', 'F'];
const BUSINESS = { rows: [1, 2, 3], cols: ['A', 'C', 'D', 'F'] };
const ECONOMY = { rows: [4, 5, 6, 7, 8, 9, 10, 11, 12], cols: ALL_COLS };

const isBusinessFareCode = (fareCode) => ['SKYBOSS', 'BUSINESS'].includes(String(fareCode || '').toUpperCase());

// Trả { code, cabin, type, price } nếu ghế hợp lệ với hạng vé, ngược lại null.
function describeSeat(rawCode, fareCode) {
  const m = /^(\d{1,2})([A-F])$/.exec(String(rawCode || '').trim().toUpperCase());
  if (!m) return null;
  const row = Number(m[1]), col = m[2], code = `${row}${col}`;
  if (isBusinessFareCode(fareCode)) {
    if (!BUSINESS.rows.includes(row) || !BUSINESS.cols.includes(col)) return null;
    return { code, cabin: 'business', type: 'Thương gia', price: 0 };
  }
  if (!ECONOMY.rows.includes(row) || !ECONOMY.cols.includes(col)) return null;
  if (row === ECONOMY.rows[0]) return { code, cabin: 'economy', type: 'Hàng đầu', price: 150000 };
  if (row === ECONOMY.rows[ECONOMY.rows.length - 1]) return { code, cabin: 'economy', type: 'Rộng chân', price: 150000 };
  return { code, cabin: 'economy', type: 'Tiêu chuẩn', price: 90000 };
}

// Nhả các ghế đang bị giữ "oan" (không còn booking hợp lệ đứng sau):
//   - booking đã hủy / hết hạn;  - booking chờ thanh toán đã quá hạn giữ chỗ (15 phút);
//   - (chỉ khi truyền userId lúc ĐẶT VÉ) booking chờ thanh toán CỦA CHÍNH KHÁCH đó: khách đặt lại sau khi thanh toán thất bại
//     thì không bị kẹt bởi lần đặt dở dang trước của chính mình.
// `exec` là db hoặc client trong transaction (có .query). codes = null -> xét mọi ghế của chuyến.
async function releaseStale(exec, flightId, codes, userId = null) {
  await exec.query(
    `UPDATE booking_seats bs SET status='RELEASED', released_at=now()
       FROM bookings b
      WHERE bs.booking_id=b.booking_id AND bs.flight_id=$1 AND bs.status='ACTIVE'
        AND ($2::text[] IS NULL OR bs.seat_code = ANY($2::text[]))
        AND ( b.status IN ('CANCELLED','EXPIRED')
              OR (b.status='PENDING_PAYMENT' AND b.expires_at IS NOT NULL AND b.expires_at <= now())
              OR ($3::uuid IS NOT NULL AND b.status='PENDING_PAYMENT' AND b.user_id=$3::uuid) )`,
    [flightId, codes, userId]
  );
}

// Trong danh sách codes, những ghế nào đang bị giữ (ACTIVE).
async function takenAmong(exec, flightId, codes) {
  const { rows } = await exec.query(
    "SELECT seat_code FROM booking_seats WHERE flight_id=$1 AND status='ACTIVE' AND seat_code = ANY($2::text[]) ORDER BY seat_code",
    [flightId, codes]
  );
  return rows.map((r) => r.seat_code);
}

// Nhả toàn bộ ghế của một booking (khi hủy vé; sau này dùng lại cho chức năng đổi chuyến).
async function releaseForBooking(exec, bookingId) {
  await exec.query("UPDATE booking_seats SET status='RELEASED', released_at=now() WHERE booking_id=$1 AND status='ACTIVE'", [bookingId]);
}

module.exports = { describeSeat, releaseStale, takenAmong, releaseForBooking, isBusinessFareCode };
