// SKYJOY - nghiệp vụ điểm khách hàng thân thiết (quy tắc của đồ án, mô phỏng chương trình SkyJoy; chỉnh trong .env).
//
//  Tích điểm : 1 điểm / SKYJOY_EARN_PER_VND đồng THỰC TRẢ của booking (sau khuyến mãi và phần trả bằng điểm), làm tròn xuống,
//              nhân hệ số hạng. Booking được xác nhận -> điểm "Chờ cộng" (PENDING); chuyến cuối hạ cánh -> "Khả dụng" (AVAILABLE).
//              Booking bị hủy trước khi bay -> điểm chờ bị hủy.
//  Hạng      : theo điểm khả dụng tích lũy 12 tháng gần nhất: Thành viên 0 · Bạc · Vàng · Kim cương (ngưỡng trong .env).
//  Dùng điểm : 1 điểm = SKYJOY_POINT_VALUE đồng; tối thiểu SKYJOY_MIN_REDEEM điểm; tối đa SKYJOY_MAX_REDEEM_RATIO giá trị đơn sau
//              khuyến mãi. Tạo booking -> điểm bị GIỮ (HELD); thanh toán xong -> trừ hẳn; booking hết hạn / hủy trước khi thanh
//              toán -> trả lại; hủy vé đã thanh toán -> hoàn điểm đã dùng (REFUND).
//  Hạn chế   : phiên bản này chưa có hết hạn điểm.
const crypto = require('crypto');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
function config() {
  const e = process.env;
  return {
    earnPerVnd: num(e.SKYJOY_EARN_PER_VND, 10000),
    pointValue: num(e.SKYJOY_POINT_VALUE, 100),
    minRedeem: num(e.SKYJOY_MIN_REDEEM, 100),
    maxRatio: num(e.SKYJOY_MAX_REDEEM_RATIO, 0.5),
    tiers: [
      { code: 'MEMBER', name: 'Thành viên', min: 0, multiplier: 1 },
      { code: 'SILVER', name: 'Bạc', min: num(e.SKYJOY_TIER_SILVER, 1000), multiplier: 1.1 },
      { code: 'GOLD', name: 'Vàng', min: num(e.SKYJOY_TIER_GOLD, 3000), multiplier: 1.25 },
      { code: 'DIAMOND', name: 'Kim cương', min: num(e.SKYJOY_TIER_DIAMOND, 6000), multiplier: 1.5 },
    ],
  };
}

const err = (status, code, message) => Object.assign(new Error(message), { status, code });

// Tạo tài khoản hội viên nếu chưa có (mã SJ + 10 chữ số, thử lại nếu trùng)
async function ensureAccount(exec, userId) {
  const cur = await exec.query('SELECT member_no FROM loyalty_accounts WHERE user_id=$1', [userId]);
  if (cur.rowCount) return cur.rows[0].member_no;
  for (let i = 0; i < 5; i++) {
    const no = 'SJ' + String(crypto.randomInt(0, 1e10)).padStart(10, '0');
    const r = await exec.query('INSERT INTO loyalty_accounts(user_id, member_no) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING member_no', [userId, no]);
    if (r.rowCount) return r.rows[0].member_no;
    const again = await exec.query('SELECT member_no FROM loyalty_accounts WHERE user_id=$1', [userId]);
    if (again.rowCount) return again.rows[0].member_no; // tạo song song
  }
  throw err(500, 'MEMBER_NO', 'Không tạo được mã hội viên SkyJoy, vui lòng thử lại.');
}

const tierFor = (tierPoints, cfg = config()) => [...cfg.tiers].reverse().find((t) => tierPoints >= t.min) || cfg.tiers[0];

// Đồng bộ trạng thái điểm theo trạng thái booking (gọi trước khi đọc / dùng điểm):
//  - trả lại điểm đang giữ của booking đã hủy / hết hạn giữ chỗ mà chưa thanh toán
//  - tạo điểm tích lũy cho booking đã xác nhận nhưng chưa có (vd. dữ liệu cũ, dữ liệu mẫu)
//  - hủy điểm chờ của booking đã hủy; chuyển điểm chờ sang khả dụng khi chuyến đã hạ cánh
async function sync(exec, userId) {
  const cfg = config();
  await exec.query(`UPDATE loyalty_transactions t SET status='CANCELLED'
      FROM bookings b WHERE t.booking_id=b.booking_id AND t.user_id=$1 AND t.type='REDEEM' AND t.status='HELD'
        AND (b.status IN ('CANCELLED','EXPIRED') OR (b.status='PENDING_PAYMENT' AND b.expires_at IS NOT NULL AND b.expires_at < now()))`, [userId]);
  await exec.query(`INSERT INTO loyalty_transactions(user_id, booking_id, type, points, status, available_at, note)
      SELECT b.user_id, b.booking_id, 'EARN', floor(b.total_amount / $2)::int, 'PENDING',
             (SELECT max(f.arrival_time) FROM booking_segments bs JOIN flights f ON f.flight_id=bs.flight_id WHERE bs.booking_id=b.booking_id),
             'Tích điểm booking ' || b.pnr
        FROM bookings b
       WHERE b.user_id=$1 AND b.status='CONFIRMED' AND floor(b.total_amount / $2) > 0
         AND NOT EXISTS (SELECT 1 FROM loyalty_transactions x WHERE x.booking_id=b.booking_id AND x.type='EARN')
      ON CONFLICT (booking_id) WHERE type = 'EARN' DO NOTHING`, [userId, cfg.earnPerVnd]);
  await exec.query(`UPDATE loyalty_transactions t SET status='CANCELLED'
      FROM bookings b WHERE t.booking_id=b.booking_id AND t.user_id=$1 AND t.type='EARN' AND t.status='PENDING' AND b.status='CANCELLED'`, [userId]);
  await exec.query("UPDATE loyalty_transactions SET status='AVAILABLE' WHERE user_id=$1 AND type='EARN' AND status='PENDING' AND available_at IS NOT NULL AND available_at <= now()", [userId]);
}

// Tổng hợp điểm: khả dụng (đã trừ điểm đang giữ), chờ cộng, đang giữ, điểm xét hạng 12 tháng, hạng hiện tại / hạng kế tiếp
async function summary(exec, userId) {
  const cfg = config();
  const r = (await exec.query(`SELECT
      coalesce(sum(points) FILTER (WHERE status='AVAILABLE'), 0)::int available_raw,
      coalesce(sum(points) FILTER (WHERE status='HELD'), 0)::int held,
      coalesce(sum(points) FILTER (WHERE status='PENDING'), 0)::int pending,
      coalesce(sum(points) FILTER (WHERE type='EARN' AND status='AVAILABLE' AND available_at >= now() - interval '12 months'), 0)::int tier_points,
      coalesce(sum(points) FILTER (WHERE type='EARN' AND status='AVAILABLE'), 0)::int lifetime
    FROM loyalty_transactions WHERE user_id=$1`, [userId])).rows[0];
  const tier = tierFor(r.tier_points, cfg);
  const next = cfg.tiers.find((t) => t.min > r.tier_points) || null;
  return {
    available: Math.max(0, r.available_raw + r.held), // điểm đang giữ (âm) không dùng được
    held: -r.held,
    pending: r.pending,
    tierPoints: r.tier_points,
    lifetimePoints: r.lifetime,
    tier: { code: tier.code, name: tier.name, multiplier: tier.multiplier },
    nextTier: next ? { code: next.code, name: next.name, min: next.min, remaining: next.min - r.tier_points } : null,
  };
}

const earnPoints = (amount, multiplier = 1, cfg = config()) => Math.floor((Number(amount) / cfg.earnPerVnd) * multiplier);

// Kiểm tra và tính tiền giảm khi dùng điểm (gọi trong transaction tạo booking, đã khóa tài khoản)
async function quoteRedeem(exec, userId, points, amountAfterPromo) {
  const cfg = config();
  const p = Math.floor(Number(points) || 0);
  if (p <= 0) return { points: 0, discount: 0 };
  await ensureAccount(exec, userId);
  await exec.query('SELECT 1 FROM loyalty_accounts WHERE user_id=$1 FOR UPDATE', [userId]); // chống dùng trùng điểm khi đặt song song
  await sync(exec, userId);
  const sum = await summary(exec, userId);
  if (p < cfg.minRedeem) throw err(422, 'SKYJOY_MIN', `Cần dùng tối thiểu ${cfg.minRedeem} điểm SkyJoy.`);
  if (p > sum.available) throw err(422, 'SKYJOY_NOT_ENOUGH', `Bạn chỉ có ${sum.available.toLocaleString('vi-VN')} điểm SkyJoy khả dụng.`);
  const maxPoints = Math.floor((amountAfterPromo * cfg.maxRatio) / cfg.pointValue);
  if (p > maxPoints) throw err(422, 'SKYJOY_MAX', `Đơn này chỉ dùng được tối đa ${maxPoints.toLocaleString('vi-VN')} điểm (${Math.round(cfg.maxRatio * 100)}% giá trị đơn).`);
  return { points: p, discount: p * cfg.pointValue };
}

async function holdRedeem(exec, userId, bookingId, points, pnr) {
  if (!points) return;
  await exec.query("INSERT INTO loyalty_transactions(user_id, booking_id, type, points, status, note) VALUES($1,$2,'REDEEM',$3,'HELD',$4)",
    [userId, bookingId, -points, `Dùng điểm cho booking ${pnr}`]);
}

// Booking vừa được xác nhận (thanh toán thành công): trừ hẳn điểm đã giữ + ghi điểm tích lũy chờ cộng
async function onBookingConfirmed(exec, bookingId) {
  const b = (await exec.query(`SELECT b.user_id, b.pnr, b.total_amount,
      (SELECT max(f.arrival_time) FROM booking_segments bs JOIN flights f ON f.flight_id=bs.flight_id WHERE bs.booking_id=b.booking_id) arrival
    FROM bookings b WHERE b.booking_id=$1`, [bookingId])).rows[0];
  if (!b || !b.user_id) return;
  await ensureAccount(exec, b.user_id);
  await exec.query("UPDATE loyalty_transactions SET status='AVAILABLE' WHERE booking_id=$1 AND type='REDEEM' AND status='HELD'", [bookingId]);
  const { tier } = await summary(exec, b.user_id);
  const pts = earnPoints(b.total_amount, tier.multiplier);
  if (pts > 0) {
    await exec.query(`INSERT INTO loyalty_transactions(user_id, booking_id, type, points, status, available_at, note)
      VALUES($1,$2,'EARN',$3,'PENDING',$4,$5) ON CONFLICT (booking_id) WHERE type = 'EARN' DO NOTHING`,
      [b.user_id, bookingId, pts, b.arrival, `Tích điểm booking ${b.pnr}${tier.multiplier > 1 ? ` (hạng ${tier.name} x${tier.multiplier})` : ''}`]);
  }
}

// Booking bị hủy: chưa thanh toán -> trả điểm đang giữ; đã thanh toán -> hủy điểm chờ cộng + hoàn điểm đã dùng
async function onBookingCancelled(exec, booking) {
  await exec.query("UPDATE loyalty_transactions SET status='CANCELLED' WHERE booking_id=$1 AND type='REDEEM' AND status='HELD'", [booking.booking_id]);
  if (booking.status !== 'CONFIRMED') return;
  await exec.query("UPDATE loyalty_transactions SET status='CANCELLED' WHERE booking_id=$1 AND type='EARN' AND status='PENDING'", [booking.booking_id]);
  if (Number(booking.points_redeemed) > 0) {
    await exec.query("INSERT INTO loyalty_transactions(user_id, booking_id, type, points, status, note) VALUES($1,$2,'REFUND',$3,'AVAILABLE',$4)",
      [booking.user_id, booking.booking_id, Number(booking.points_redeemed), `Hoàn điểm do hủy booking ${booking.pnr}`]);
  }
}

module.exports = { config, ensureAccount, sync, summary, tierFor, earnPoints, quoteRedeem, holdRedeem, onBookingConfirmed, onBookingCancelled };
