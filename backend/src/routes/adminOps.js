// Admin Center - các module còn lại, ghi/đọc thẳng PostgreSQL (thay cho dữ liệu mẫu gắn cứng trên trình duyệt trước đây):
//   Tổng quan (dashboard) · Sân bay · Tuyến bay · Máy bay · Hạng vé/giá vé · Đánh giá · Hội thoại · Thông báo · Khách hàng
// Mount TRƯỚC routes/admin.js nên các route ở đây được ưu tiên.
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { validateBody } = require('../middleware/validate');
const { revokeAllForUser } = require('../utils/refreshToken');

const STAFF_ROLES = ['ADMIN', 'SUPPORT'];
const staffOnly = (req, res, next) => (req.user && STAFF_ROLES.includes(req.user.role) ? next() : res.status(403).json({ code: 'FORBIDDEN', message: 'Chỉ nhân viên nội bộ mới truy cập được.' }));
const guard = (perm) => [auth(), staffOnly, requirePermission(perm)];
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const idParam = (req, res, next) => (isUuid(req.params.id) ? next() : res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu.' }));
const inUse = (msg) => (e, next) => (e.code === '23503' ? next(httpErr(409, 'IN_USE', msg)) : next(e));
const page = (req, def = 20, max = 100) => { const size = Math.min(max, Math.max(1, +req.query.size || def)); const p = Math.max(1, +req.query.page || 1); return { size, page: p, offset: (p - 1) * size }; };

// =====================================================================
// TỔNG QUAN (mọi nhân viên đã đăng nhập)
// =====================================================================
router.get('/dashboard', auth(), staffOnly, async (req, res, next) => {
  try {
    const TZ = "'Asia/Ho_Chi_Minh'";
    const today = `(now() AT TIME ZONE ${TZ})::date`;
    const [stats, revenue7, recent] = await Promise.all([
      db.query(`SELECT
          (SELECT count(*)::int FROM flights WHERE (departure_time AT TIME ZONE ${TZ})::date = ${today} AND status<>'CANCELLED') "flightsToday",
          (SELECT count(*)::int FROM flights WHERE (departure_time AT TIME ZONE ${TZ})::date = ${today} - 1 AND status<>'CANCELLED') "flightsYesterday",
          (SELECT count(*)::int FROM flights WHERE departure_time >= now() AND status='OPEN_FOR_SALE') "flightsOnSale",
          (SELECT coalesce(sum(amount - refunded_amount),0)::float FROM payments WHERE status='SUCCEEDED' AND (created_at AT TIME ZONE ${TZ})::date = ${today}) "revenueToday",
          (SELECT coalesce(sum(amount - refunded_amount),0)::float FROM payments WHERE status='SUCCEEDED' AND (created_at AT TIME ZONE ${TZ})::date = ${today} - 1) "revenueYesterday",
          (SELECT coalesce(sum(amount - refunded_amount),0)::float FROM payments WHERE status='SUCCEEDED') "revenueTotal",
          (SELECT count(*)::int FROM bookings WHERE status='CONFIRMED') "bookingsConfirmed",
          (SELECT count(*)::int FROM bookings WHERE status='PENDING_PAYMENT' AND (expires_at IS NULL OR expires_at > now())) "bookingsPending",
          (SELECT count(*)::int FROM bookings WHERE (created_at AT TIME ZONE ${TZ})::date = ${today}) "bookingsToday",
          (SELECT count(*)::int FROM passengers p JOIN bookings b ON b.booking_id=p.booking_id WHERE b.status='CONFIRMED') "passengers",
          (SELECT count(DISTINCT ur.user_id)::int FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE r.code='CUSTOMER') "customers",
          (SELECT count(*)::int FROM chat_conversations WHERE status<>'CLOSED') "openChats",
          (SELECT count(*)::int FROM reviews WHERE status='PENDING') "pendingReviews",
          (SELECT round(avg(rating)::numeric,2)::float FROM reviews WHERE status='APPROVED') "avgRating",
          (SELECT count(*)::int FROM refund_requests WHERE status='REQUESTED') "pendingRefunds"`),
      db.query(`SELECT to_char(d,'YYYY-MM-DD') "day", coalesce(sum(p.amount - p.refunded_amount),0)::float revenue, count(p.payment_id)::int payments
        FROM generate_series(${today} - 6, ${today}, interval '1 day') d
        LEFT JOIN payments p ON p.status='SUCCEEDED' AND (p.created_at AT TIME ZONE ${TZ})::date = d::date
        GROUP BY d ORDER BY d`),
      db.query(`SELECT * FROM (
          SELECT 'BOOKING' kind, b.created_at at, 'Booking ' || b.pnr || ' · ' || coalesce(u.full_name,'Khách') || ' · ' ||
                 CASE b.status WHEN 'CONFIRMED' THEN 'đã thanh toán' WHEN 'CANCELLED' THEN 'đã hủy' WHEN 'PENDING_PAYMENT' THEN 'chờ thanh toán' ELSE lower(b.status) END text
            FROM bookings b LEFT JOIN users u ON u.user_id=b.user_id
          UNION ALL SELECT 'REVIEW', r.created_at, 'Đánh giá ' || r.rating || '★ từ ' || u.full_name FROM reviews r JOIN users u ON u.user_id=r.user_id
          UNION ALL SELECT 'CHAT', c.created_at, 'Hội thoại mới: ' || coalesce(c.topic,'Hỗ trợ') || ' · ' || coalesce(u.full_name,'Khách') FROM chat_conversations c LEFT JOIN users u ON u.user_id=c.user_id
          UNION ALL SELECT 'CUSTOMER', u.created_at, 'Khách hàng mới đăng ký: ' || u.full_name FROM users u WHERE EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND r.code='CUSTOMER')
        ) x ORDER BY at DESC LIMIT 8`),
    ]);
    res.json({ stats: stats.rows[0], revenue7: revenue7.rows, recent: recent.rows, serverTime: new Date().toISOString() });
  } catch (e) { next(e); }
});

// =====================================================================
// SÂN BAY
// =====================================================================
const AIRPORT_SELECT = `SELECT a.airport_id id, a.iata_code code, a.name, a.city, a.country, a.timezone, a.status,
  (SELECT count(*)::int FROM routes r WHERE r.origin_id=a.airport_id OR r.destination_id=a.airport_id) "routeCount" FROM airports a`;
const airportSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Mã IATA gồm 3 chữ cái.').transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(150),
  city: z.string().trim().min(1).max(100),
  country: z.string().trim().min(2).max(60).default('Việt Nam'),
  timezone: z.string().trim().min(3).max(60).default('Asia/Ho_Chi_Minh'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
router.get('/airports', guard('routes.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${AIRPORT_SELECT} ORDER BY a.country <> 'Việt Nam', a.iata_code`)).rows }); } catch (e) { next(e); }
});
router.post('/airports', guard('routes.manage'), validateBody(airportSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query('INSERT INTO airports(iata_code,name,city,country,timezone,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING airport_id', [v.code, v.name, v.city, v.country, v.timezone, v.status]);
    res.status(201).json((await db.query(`${AIRPORT_SELECT} WHERE a.airport_id=$1`, [r.rows[0].airport_id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/airports/:id', guard('routes.manage'), idParam, validateBody(airportSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query('UPDATE airports SET iata_code=$2,name=$3,city=$4,country=$5,timezone=$6,status=$7 WHERE airport_id=$1', [req.params.id, v.code, v.name, v.city, v.country, v.timezone, v.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy sân bay.');
    res.json((await db.query(`${AIRPORT_SELECT} WHERE a.airport_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/airports/:id/status', guard('routes.manage'), idParam, validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE airports SET status=$2 WHERE airport_id=$1', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy sân bay.');
    res.json({ message: 'Đã cập nhật trạng thái.' });
  } catch (e) { next(e); }
});
router.delete('/airports/:id', guard('routes.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM airports WHERE airport_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy sân bay.');
    res.json({ message: 'Đã xóa sân bay.' });
  } catch (e) { inUse('Sân bay đang có tuyến bay / chuyến bay nên không thể xóa. Hãy chuyển sang "Tạm ngưng".')(e, next); }
});

// =====================================================================
// TUYẾN BAY
// =====================================================================
const ROUTE_SELECT = `SELECT r.route_id id, ao.iata_code origin, ao.city "originCity", ad.iata_code destination, ad.city "destinationCity",
    r.distance_km "distanceKm", r.duration_min "durationMin", r.status,
    CASE WHEN ao.country = ad.country THEN 'DOMESTIC' ELSE 'INTERNATIONAL' END "routeType",
    (SELECT count(*)::int FROM flights f WHERE f.origin_id=r.origin_id AND f.destination_id=r.destination_id AND f.departure_time>=now() AND f.status='OPEN_FOR_SALE') "upcomingFlights"
  FROM routes r JOIN airports ao ON ao.airport_id=r.origin_id JOIN airports ad ON ad.airport_id=r.destination_id`;
const routeSchema = z.object({
  origin: z.string().trim().length(3).transform((s) => s.toUpperCase()),
  destination: z.string().trim().length(3).transform((s) => s.toUpperCase()),
  distanceKm: z.number().int().positive().nullish(),
  durationMin: z.number().int().positive().nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
}).refine((v) => v.origin !== v.destination, { path: ['destination'], message: 'Điểm đến phải khác điểm đi.' });
async function airportIds(c, codes) {
  const rows = (await c.query('SELECT iata_code, airport_id FROM airports WHERE iata_code = ANY($1)', [codes])).rows;
  const map = Object.fromEntries(rows.map((r) => [r.iata_code, r.airport_id]));
  for (const code of codes) if (!map[code]) throw httpErr(422, 'AIRPORT_UNKNOWN', `Sân bay ${code} không tồn tại.`);
  return map;
}
router.get('/routes', guard('routes.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${ROUTE_SELECT} ORDER BY ao.iata_code, ad.iata_code`)).rows }); } catch (e) { next(e); }
});
router.post('/routes', guard('routes.manage'), validateBody(routeSchema), async (req, res, next) => {
  try {
    const v = req.body, ids = await airportIds(db, [v.origin, v.destination]);
    const r = await db.query('INSERT INTO routes(origin_id,destination_id,distance_km,duration_min,status) VALUES($1,$2,$3,$4,$5) RETURNING route_id', [ids[v.origin], ids[v.destination], v.distanceKm ?? null, v.durationMin ?? null, v.status]);
    res.status(201).json((await db.query(`${ROUTE_SELECT} WHERE r.route_id=$1`, [r.rows[0].route_id])).rows[0]);
  } catch (e) { if (e.code === '23505') return next(httpErr(409, 'DUPLICATE', 'Tuyến bay này đã tồn tại.')); next(e); }
});
router.patch('/routes/:id', guard('routes.manage'), idParam, validateBody(routeSchema), async (req, res, next) => {
  try {
    const v = req.body, ids = await airportIds(db, [v.origin, v.destination]);
    const r = await db.query('UPDATE routes SET origin_id=$2,destination_id=$3,distance_km=$4,duration_min=$5,status=$6 WHERE route_id=$1', [req.params.id, ids[v.origin], ids[v.destination], v.distanceKm ?? null, v.durationMin ?? null, v.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy tuyến bay.');
    res.json((await db.query(`${ROUTE_SELECT} WHERE r.route_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { if (e.code === '23505') return next(httpErr(409, 'DUPLICATE', 'Tuyến bay này đã tồn tại.')); next(e); }
});
router.patch('/routes/:id/status', guard('routes.manage'), idParam, validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE routes SET status=$2 WHERE route_id=$1', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy tuyến bay.');
    res.json({ message: 'Đã cập nhật trạng thái.' });
  } catch (e) { next(e); }
});
router.delete('/routes/:id', guard('routes.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM routes WHERE route_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy tuyến bay.');
    res.json({ message: 'Đã xóa tuyến bay.' });
  } catch (e) { next(e); }
});

// =====================================================================
// MÁY BAY
// =====================================================================
const AIRCRAFT_SELECT = `SELECT a.aircraft_id id, a.registration_no code, a.model, a.status,
    coalesce(a.seat_capacity, (SELECT count(*)::int FROM seats s WHERE s.aircraft_id=a.aircraft_id AND s.status='ACTIVE')) "seatCapacity",
    a.manufacture_year "manufactureYear", a.flight_hours::float "flightHours", to_char(a.next_maintenance,'YYYY-MM-DD') "nextMaintenance",
    (SELECT count(*)::int FROM flights f WHERE f.aircraft_id=a.aircraft_id AND f.departure_time>=now() AND f.status<>'CANCELLED') "upcomingFlights"
  FROM aircraft a`;
const aircraftSchema = z.object({
  code: z.string().trim().min(3).max(20).transform((s) => s.toUpperCase()),
  model: z.string().trim().min(2).max(80),
  seatCapacity: z.number().int().positive().max(900),
  manufactureYear: z.number().int().min(1950).max(new Date().getFullYear() + 1).nullish(),
  flightHours: z.number().min(0).default(0),
  nextMaintenance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'INACTIVE']).default('ACTIVE'),
});
const aircraftArgs = (v) => [v.code, v.model, v.status, v.seatCapacity, v.manufactureYear ?? null, v.flightHours, v.nextMaintenance || null];
router.get('/aircraft', guard('aircraft.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${AIRCRAFT_SELECT} ORDER BY a.registration_no`)).rows }); } catch (e) { next(e); }
});
router.post('/aircraft', guard('aircraft.manage'), validateBody(aircraftSchema), async (req, res, next) => {
  try {
    const r = await db.query('INSERT INTO aircraft(registration_no,model,status,seat_capacity,manufacture_year,flight_hours,next_maintenance) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING aircraft_id', aircraftArgs(req.body));
    res.status(201).json((await db.query(`${AIRCRAFT_SELECT} WHERE a.aircraft_id=$1`, [r.rows[0].aircraft_id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/aircraft/:id', guard('aircraft.manage'), idParam, validateBody(aircraftSchema), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE aircraft SET registration_no=$2,model=$3,status=$4,seat_capacity=$5,manufacture_year=$6,flight_hours=$7,next_maintenance=$8 WHERE aircraft_id=$1', [req.params.id, ...aircraftArgs(req.body)]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy máy bay.');
    res.json((await db.query(`${AIRCRAFT_SELECT} WHERE a.aircraft_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/aircraft/:id/status', guard('aircraft.manage'), idParam, validateBody(z.object({ status: z.enum(['ACTIVE', 'MAINTENANCE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE aircraft SET status=$2 WHERE aircraft_id=$1', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy máy bay.');
    res.json({ message: 'Đã cập nhật trạng thái.' });
  } catch (e) { next(e); }
});
router.delete('/aircraft/:id', guard('aircraft.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.tx(async (c) => {
      if ((await c.query('SELECT 1 FROM flights WHERE aircraft_id=$1 LIMIT 1', [req.params.id])).rowCount) throw httpErr(409, 'IN_USE', 'Máy bay đã được xếp cho chuyến bay nên không thể xóa. Hãy chuyển sang "Tạm ngưng".');
      await c.query('DELETE FROM seats WHERE aircraft_id=$1', [req.params.id]);
      return c.query('DELETE FROM aircraft WHERE aircraft_id=$1', [req.params.id]);
    });
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy máy bay.');
    res.json({ message: 'Đã xóa máy bay.' });
  } catch (e) { inUse('Máy bay đang được sử dụng nên không thể xóa.')(e, next); }
});

// =====================================================================
// HẠNG VÉ / GIÁ VÉ (fare_classes + thống kê giá thực tế từ flight_fares)
// =====================================================================
const FARE_SELECT = `SELECT fc.fare_class_id id, fc.code, fc.name, fc.status, fc.description, fc.conditions,
    coalesce((fc.conditions->>'baggageKg')::int, 0) "baggageKg", coalesce(fc.conditions->>'change','FEE') "changePolicy",
    coalesce((fc.conditions->>'refundable')::boolean, false) refundable,
    st.flights::int "upcomingFlights", st.min_price::float "minPrice", st.avg_price::float "avgPrice", st.max_price::float "maxPrice"
  FROM fare_classes fc
  LEFT JOIN LATERAL (SELECT count(*) flights, min(ff.price) min_price, round(avg(ff.price)) avg_price, max(ff.price) max_price
      FROM flight_fares ff JOIN flights f ON f.flight_id=ff.flight_id
     WHERE ff.fare_class_id=fc.fare_class_id AND ff.status='ACTIVE' AND f.departure_time>=now() AND f.status='OPEN_FOR_SALE') st ON true`;
const fareSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_]{2,20}$/, 'Mã hạng vé 2-20 ký tự (chữ, số, _).').transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(80),
  baggageKg: z.number().int().min(0).max(100).default(0),
  changePolicy: z.enum(['FREE', 'FEE', 'NONE']).default('FEE'),
  refundable: z.boolean().default(false),
  description: z.string().trim().max(500).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
const fareConditions = (v) => JSON.stringify({ baggageKg: v.baggageKg, change: v.changePolicy, refundable: v.refundable });
router.get('/fares', guard('fares.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${FARE_SELECT} ORDER BY st.min_price NULLS LAST, fc.code`)).rows }); } catch (e) { next(e); }
});
router.post('/fares', guard('fares.manage'), validateBody(fareSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query('INSERT INTO fare_classes(code,name,conditions,description,status) VALUES($1,$2,$3,$4,$5) RETURNING fare_class_id', [v.code, v.name, fareConditions(v), v.description || null, v.status]);
    res.status(201).json((await db.query(`${FARE_SELECT} WHERE fc.fare_class_id=$1`, [r.rows[0].fare_class_id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/fares/:id', guard('fares.manage'), idParam, validateBody(fareSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query('UPDATE fare_classes SET code=$2,name=$3,conditions=conditions || $4::jsonb,description=$5,status=$6 WHERE fare_class_id=$1', [req.params.id, v.code, v.name, fareConditions(v), v.description || null, v.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hạng vé.');
    res.json((await db.query(`${FARE_SELECT} WHERE fc.fare_class_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/fares/:id/status', guard('fares.manage'), idParam, validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE fare_classes SET status=$2 WHERE fare_class_id=$1', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hạng vé.');
    res.json({ message: 'Đã cập nhật trạng thái.' });
  } catch (e) { next(e); }
});
// Điều chỉnh giá hàng loạt cho các chuyến SẮP TỚI của một hạng vé (tùy chọn theo tuyến): { percent } hoặc { price }
router.post('/fares/:id/reprice', guard('fares.manage'), idParam, validateBody(z.object({
  origin: z.string().trim().length(3).optional(), destination: z.string().trim().length(3).optional(),
  percent: z.number().min(-90).max(500).optional(), price: z.number().min(0).optional(),
}).refine((v) => v.percent !== undefined || v.price !== undefined, { message: 'Cần nhập phần trăm điều chỉnh hoặc giá mới.' })), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query(`UPDATE flight_fares ff SET price = CASE WHEN $2::numeric IS NOT NULL THEN $2::numeric ELSE round(ff.price * (100 + $3::numeric) / 100, -3) END
      FROM flights f JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id
      WHERE ff.flight_id=f.flight_id AND ff.fare_class_id=$1 AND f.departure_time>=now()
        AND ($4::text IS NULL OR ao.iata_code=upper($4)) AND ($5::text IS NULL OR ad.iata_code=upper($5))`,
      [req.params.id, v.price ?? null, v.percent ?? 0, v.origin || null, v.destination || null]);
    res.json({ updated: r.rowCount, message: `Đã cập nhật giá cho ${r.rowCount} chuyến bay.` });
  } catch (e) { next(e); }
});
router.delete('/fares/:id', guard('fares.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM fare_classes WHERE fare_class_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hạng vé.');
    res.json({ message: 'Đã xóa hạng vé.' });
  } catch (e) { inUse('Hạng vé đang được dùng cho chuyến bay / đặt chỗ nên không thể xóa. Hãy chuyển sang "Tạm dừng".')(e, next); }
});

// =====================================================================
// ĐÁNH GIÁ
// =====================================================================
const REVIEW_SELECT = `SELECT r.review_id id, r.rating, r.content, r.status, r.admin_reply "adminReply", r.created_at "createdAt", r.moderated_at "moderatedAt",
    u.full_name customer, u.email "customerEmail", u.phone "customerPhone", t.ticket_no "ticketNo",
    f.flight_no "flightNo", ao.iata_code "from", ad.iata_code "to", f.departure_time "departureTime"
  FROM reviews r JOIN users u ON u.user_id=r.user_id JOIN tickets t ON t.ticket_id=r.ticket_id
  JOIN booking_segments bs ON bs.segment_id=t.segment_id JOIN flights f ON f.flight_id=bs.flight_id
  JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id`;
router.get('/reviews', guard('reviews.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${REVIEW_SELECT} ORDER BY r.created_at DESC LIMIT 1000`)).rows }); } catch (e) { next(e); }
});
router.patch('/reviews/:id/moderation', guard('reviews.manage'), idParam, validateBody(z.object({
  status: z.enum(['PENDING', 'APPROVED', 'HIDDEN', 'NEEDS_REPLY']),
  adminReply: z.string().trim().max(1000).nullish(),
})), async (req, res, next) => {
  try {
    const out = await db.tx(async (c) => {
      const before = (await c.query('SELECT user_id, admin_reply FROM reviews WHERE review_id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!before) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy đánh giá.');
      const reply = req.body.adminReply === undefined ? before.admin_reply : (req.body.adminReply || null);
      await c.query('UPDATE reviews SET status=$2, admin_reply=$3, moderated_at=now() WHERE review_id=$1', [req.params.id, req.body.status, reply]);
      if (reply && reply !== before.admin_reply) {
        await c.query("INSERT INTO notifications(user_id,type,title,body,status,sent_at,created_by) VALUES($1,'REVIEW_REPLY','Vietjet đã phản hồi đánh giá của bạn',$2,'SENT',now(),$3)", [before.user_id, reply.slice(0, 2000), req.user.sub]);
      }
      return (await c.query(`${REVIEW_SELECT} WHERE r.review_id=$1`, [req.params.id])).rows[0];
    });
    res.json(out);
  } catch (e) { next(e); }
});
router.patch('/reviews/:id/status', guard('reviews.manage'), idParam, validateBody(z.object({ status: z.enum(['PENDING', 'APPROVED', 'HIDDEN', 'NEEDS_REPLY']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE reviews SET status=$2, moderated_at=now() WHERE review_id=$1', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy đánh giá.');
    res.json({ message: 'Đã cập nhật trạng thái.' });
  } catch (e) { next(e); }
});
router.delete('/reviews/:id', guard('reviews.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM reviews WHERE review_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy đánh giá.');
    res.json({ message: 'Đã xóa đánh giá.' });
  } catch (e) { next(e); }
});

// =====================================================================
// HỘI THOẠI (CSKH)
// =====================================================================
const CHAT_SELECT = `SELECT c.conversation_id id, c.topic, c.status, c.created_at "createdAt", c.updated_at "updatedAt", c.closed_at "closedAt",
    u.full_name customer, u.email "customerEmail", u.phone "customerPhone", ag.user_id "agentId", ag.full_name agent, b.pnr,
    lm.body "lastMessage", lm.sender_type "lastSender", lm.sent_at "lastAt",
    (SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id=c.conversation_id AND m.sender_type='CUSTOMER'
       AND m.sent_at > coalesce((SELECT max(x.sent_at) FROM chat_messages x WHERE x.conversation_id=c.conversation_id AND x.sender_type='AGENT'), 'epoch')) unread
  FROM chat_conversations c
  LEFT JOIN users u ON u.user_id=c.user_id LEFT JOIN users ag ON ag.user_id=c.assigned_agent_id LEFT JOIN bookings b ON b.booking_id=c.booking_id
  LEFT JOIN LATERAL (SELECT body, sender_type, sent_at FROM chat_messages m WHERE m.conversation_id=c.conversation_id ORDER BY sent_at DESC LIMIT 1) lm ON true`;
router.get('/chats', guard('chats.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${CHAT_SELECT} ORDER BY (c.status='CLOSED'), c.updated_at DESC LIMIT 500`)).rows }); } catch (e) { next(e); }
});
router.get('/chats/agents', guard('chats.manage'), async (req, res, next) => {
  try {
    const q = await db.query(`SELECT DISTINCT u.user_id id, u.full_name "fullName" FROM users u JOIN user_roles ur ON ur.user_id=u.user_id JOIN roles r ON r.role_id=ur.role_id
      LEFT JOIN user_permissions up ON up.user_id=u.user_id LEFT JOIN permissions p ON p.permission_id=up.permission_id
      WHERE u.status='ACTIVE' AND (r.code='ADMIN' OR (r.code='SUPPORT' AND p.code='chats.manage')) ORDER BY 2`);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});
router.get('/chats/:id/messages', guard('chats.manage'), idParam, async (req, res, next) => {
  try {
    const conv = (await db.query(`${CHAT_SELECT} WHERE c.conversation_id=$1`, [req.params.id])).rows[0];
    if (!conv) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hội thoại.');
    const q = await db.query(`SELECT m.message_id id, m.sender_type "senderType", m.body, m.sent_at "sentAt", m.read_at "readAt", su.full_name "senderName"
      FROM chat_messages m LEFT JOIN users su ON su.user_id=m.sender_id WHERE m.conversation_id=$1 ORDER BY m.sent_at`, [req.params.id]);
    await db.query("UPDATE chat_messages SET read_at=now() WHERE conversation_id=$1 AND sender_type='CUSTOMER' AND read_at IS NULL", [req.params.id]);
    res.json({ conversation: conv, items: q.rows });
  } catch (e) { next(e); }
});
router.post('/chats/:id/messages', guard('chats.manage'), idParam, validateBody(z.object({ body: z.string().trim().min(1).max(2000) })), async (req, res, next) => {
  try {
    const out = await db.tx(async (c) => {
      const conv = (await c.query('SELECT status FROM chat_conversations WHERE conversation_id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!conv) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hội thoại.');
      if (conv.status === 'CLOSED') throw httpErr(409, 'CONVERSATION_CLOSED', 'Hội thoại đã đóng. Mở lại hội thoại trước khi trả lời.');
      const m = (await c.query("INSERT INTO chat_messages(conversation_id,sender_id,sender_type,body) VALUES($1,$2,'AGENT',$3) RETURNING message_id id, sender_type \"senderType\", body, sent_at \"sentAt\"", [req.params.id, req.user.sub, req.body.body])).rows[0];
      await c.query("UPDATE chat_conversations SET updated_at=now(), status=CASE WHEN status='OPEN' THEN 'IN_PROGRESS' ELSE status END, assigned_agent_id=coalesce(assigned_agent_id,$2) WHERE conversation_id=$1", [req.params.id, req.user.sub]);
      return m;
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});
router.patch('/chats/:id', guard('chats.manage'), idParam, validateBody(z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']).optional(),
  assignedAgentId: z.string().uuid().nullish(),
  topic: z.string().trim().min(1).max(120).optional(),
})), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query(`UPDATE chat_conversations SET status=coalesce($2,status), topic=coalesce($4,topic),
        assigned_agent_id=CASE WHEN $5 THEN $3::uuid ELSE assigned_agent_id END, updated_at=now(),
        closed_at=CASE WHEN $2='CLOSED' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE closed_at END
      WHERE conversation_id=$1`, [req.params.id, v.status || null, v.assignedAgentId || null, v.topic || null, v.assignedAgentId !== undefined]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hội thoại.');
    res.json((await db.query(`${CHAT_SELECT} WHERE c.conversation_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/chats/:id/status', guard('chats.manage'), idParam, validateBody(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']) })), async (req, res, next) => {
  try {
    const r = await db.query("UPDATE chat_conversations SET status=$2, updated_at=now(), closed_at=CASE WHEN $2='CLOSED' THEN now() ELSE NULL END WHERE conversation_id=$1", [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hội thoại.');
    res.json({ message: 'Đã cập nhật trạng thái.' });
  } catch (e) { next(e); }
});
router.delete('/chats/:id', guard('chats.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM chat_conversations WHERE conversation_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy hội thoại.');
    res.json({ message: 'Đã xóa hội thoại.' });
  } catch (e) { next(e); }
});

// =====================================================================
// THÔNG BÁO (gửi cho 1 khách hoặc toàn bộ khách hàng; gửi ngay hoặc hẹn giờ)
// Mỗi lần gửi = 1 "chiến dịch" (campaign_id), mỗi khách nhận 1 dòng trong bảng notifications.
// =====================================================================
const NOTI_SELECT = `SELECT coalesce(n.campaign_id, n.notification_id) id, (n.campaign_id IS NOT NULL) campaign,
    min(n.title) title, min(n.body) body, min(n.type) type,
    CASE WHEN bool_and(n.status='CANCELLED') THEN 'CANCELLED' WHEN bool_or(n.status='QUEUED' AND n.scheduled_at>now()) THEN 'SCHEDULED' ELSE 'SENT' END status,
    min(n.scheduled_at) "scheduledAt", min(n.created_at) "createdAt", max(n.sent_at) "sentAt",
    count(*)::int recipients, count(n.read_at)::int "readCount",
    CASE WHEN count(*)=1 THEN min(coalesce(u.full_name,'') || CASE WHEN u.email IS NOT NULL THEN ' <' || u.email || '>' ELSE '' END) ELSE NULL END "recipientName",
    min(cb.full_name) "createdBy", bool_or(n.booking_id IS NOT NULL) "system"
  FROM notifications n LEFT JOIN users u ON u.user_id=n.user_id LEFT JOIN users cb ON cb.user_id=n.created_by`;
const NOTI_GROUP = 'GROUP BY coalesce(n.campaign_id, n.notification_id), (n.campaign_id IS NOT NULL)';
router.get('/notifications', guard('notifications.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${NOTI_SELECT} ${NOTI_GROUP} ORDER BY min(n.created_at) DESC LIMIT 500`)).rows }); } catch (e) { next(e); }
});
const notiSchema = z.object({
  title: z.string().trim().min(2).max(200),
  body: z.string().trim().min(2).max(2000),
  type: z.enum(['SYSTEM', 'PROMOTION', 'FLIGHT_UPDATE', 'CHECKIN_REMINDER', 'BOOKING']).default('SYSTEM'),
  audience: z.enum(['ALL', 'USER']).default('ALL'),
  recipient: z.string().trim().max(255).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
}).refine((v) => v.audience === 'ALL' || (v.recipient && v.recipient.length >= 3), { path: ['recipient'], message: 'Nhập email hoặc số điện thoại khách hàng nhận thông báo.' });
router.post('/notifications', guard('notifications.manage'), validateBody(notiSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const scheduled = v.scheduledAt && new Date(v.scheduledAt) > new Date() ? v.scheduledAt : null;
    const out = await db.tx(async (c) => {
      let users;
      const CUSTOMER = "EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND r.code='CUSTOMER')";
      if (v.audience === 'USER') {
        const key = v.recipient.trim();
        users = (await c.query(`SELECT u.user_id FROM users u WHERE ${CUSTOMER} AND (lower(u.email)=lower($1) OR u.phone=$1 OR u.user_id::text=$1)`, [key])).rows;
        if (!users.length) throw httpErr(404, 'CUSTOMER_NOT_FOUND', 'Không tìm thấy khách hàng với email / số điện thoại này.');
      } else {
        users = (await c.query(`SELECT u.user_id FROM users u WHERE u.status='ACTIVE' AND ${CUSTOMER}`)).rows;
        if (!users.length) throw httpErr(422, 'NO_CUSTOMERS', 'Chưa có khách hàng nào để gửi thông báo.');
      }
      const campaign = (await c.query('SELECT gen_random_uuid() id')).rows[0].id;
      await c.query(`INSERT INTO notifications(user_id,type,title,body,status,scheduled_at,sent_at,campaign_id,created_by)
        SELECT x, $2, $3, $4, CASE WHEN $5::timestamptz IS NULL THEN 'SENT' ELSE 'QUEUED' END, $5::timestamptz, CASE WHEN $5::timestamptz IS NULL THEN now() END, $6, $7
        FROM unnest($1::uuid[]) x`, [users.map((u) => u.user_id), v.type, v.title, v.body, scheduled, campaign, req.user.sub]);
      return (await c.query(`${NOTI_SELECT} WHERE n.campaign_id=$1 ${NOTI_GROUP}`, [campaign])).rows[0];
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});
const notiWhere = 'WHERE (campaign_id=$1 OR (campaign_id IS NULL AND notification_id=$1))';
router.patch('/notifications/:id/cancel', guard('notifications.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query(`UPDATE notifications SET status='CANCELLED' ${notiWhere} AND status='QUEUED'`, [req.params.id]);
    if (!r.rowCount) throw httpErr(409, 'NOT_CANCELLABLE', 'Chỉ hủy được thông báo đang hẹn giờ (chưa gửi).');
    res.json({ message: `Đã hủy thông báo (${r.rowCount} người nhận).` });
  } catch (e) { next(e); }
});
router.delete('/notifications/:id', guard('notifications.manage'), idParam, async (req, res, next) => {
  try {
    const r = await db.query(`DELETE FROM notifications ${notiWhere}`, [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy thông báo.');
    res.json({ message: 'Đã xóa thông báo.' });
  } catch (e) { next(e); }
});

// =====================================================================
// KHÁCH HÀNG (user có role CUSTOMER)
// =====================================================================
const CUSTOMER_FILTER = "EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.role_id=ur.role_id WHERE ur.user_id=u.user_id AND r.code='CUSTOMER')";
const CUSTOMER_COLS = `u.user_id id, u.full_name "fullName", u.email, u.phone, u.status, to_char(u.date_of_birth,'YYYY-MM-DD') "dateOfBirth",
    u.hometown, u.national_id "nationalId", u.created_at "createdAt", u.locked_until "lockedUntil",
    (SELECT count(*)::int FROM bookings b WHERE b.user_id=u.user_id) "bookingCount",
    (SELECT count(*)::int FROM bookings b WHERE b.user_id=u.user_id AND b.status='CONFIRMED') "confirmedCount",
    (SELECT coalesce(sum(p.amount - p.refunded_amount),0)::float FROM payments p JOIN bookings b ON b.booking_id=p.booking_id WHERE b.user_id=u.user_id AND p.status='SUCCEEDED') "totalSpent"`;
router.get('/customers', guard('customers.manage'), async (req, res, next) => {
  try {
    const { size, page: p, offset } = page(req, 20, 200);
    const params = []; let where = CUSTOMER_FILTER;
    if (req.query.q) { params.push(`%${String(req.query.q).trim().toLowerCase()}%`); where += ` AND (lower(u.full_name) LIKE $${params.length} OR lower(coalesce(u.email,'')) LIKE $${params.length} OR coalesce(u.phone,'') LIKE $${params.length})`; }
    if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where += ` AND u.status=$${params.length}`; }
    const total = (await db.query(`SELECT count(*)::int n FROM users u WHERE ${where}`, params)).rows[0].n;
    const q = await db.query(`SELECT ${CUSTOMER_COLS} FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ${size} OFFSET ${offset}`, params);
    res.json({ items: q.rows, total, page: p, size });
  } catch (e) { next(e); }
});
router.get('/customers/:id', guard('customers.manage'), idParam, async (req, res, next) => {
  try {
    const c = (await db.query(`SELECT ${CUSTOMER_COLS} FROM users u WHERE u.user_id=$1 AND ${CUSTOMER_FILTER}`, [req.params.id])).rows[0];
    if (!c) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');
    const bookings = await db.query(`SELECT b.booking_id id, b.pnr, b.status, b.total_amount::float "totalAmount", b.created_at "createdAt",
        (SELECT string_agg(f.flight_no || ' ' || ao.iata_code || '→' || ad.iata_code || ' ' || to_char(f.departure_time AT TIME ZONE 'Asia/Ho_Chi_Minh','DD/MM/YYYY HH24:MI'), ' · ' ORDER BY f.departure_time)
           FROM booking_segments bs JOIN flights f ON f.flight_id=bs.flight_id JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id WHERE bs.booking_id=b.booking_id) itinerary
      FROM bookings b WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [req.params.id]);
    res.json({ ...c, bookings: bookings.rows });
  } catch (e) { next(e); }
});
router.patch('/customers/:id/status', guard('customers.manage'), idParam, validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const out = await db.tx(async (c) => {
      const r = await c.query(`UPDATE users u SET status=$2, failed_login_count=0, locked_until=NULL, updated_at=now() WHERE u.user_id=$1 AND ${CUSTOMER_FILTER}`, [req.params.id, req.body.status]);
      if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy khách hàng.');
      if (req.body.status !== 'ACTIVE') await revokeAllForUser(req.params.id, c); // khóa -> đăng xuất mọi thiết bị
      return r;
    });
    res.json({ message: req.body.status === 'ACTIVE' ? 'Đã mở khóa tài khoản khách hàng.' : 'Đã khóa tài khoản khách hàng.', updated: out.rowCount });
  } catch (e) { next(e); }
});

module.exports = router;
