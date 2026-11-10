// Admin Center - quản lý CHUYẾN BAY, KHUYẾN MÃI, DỊCH VỤ: CRUD ghi thẳng vào PostgreSQL.
// Mount TRƯỚC routes/admin.js nên các route ở đây được ưu tiên.
const router = require('express').Router();
const { z } = require('zod');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { validateBody } = require('../middleware/validate');

const guard = (perm) => [auth(), requirePermission(perm)];
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });
const iso = z.iso.datetime({ offset: true });
const uuid = z.string().uuid();

// ---------- Danh mục dùng cho ô chọn (sân bay, máy bay, hạng vé) ----------
router.get('/meta', auth(), async (req, res, next) => {
  try {
    const [airports, aircraft, fareClasses] = await Promise.all([
      db.query("SELECT iata_code code, name, city FROM airports WHERE status='ACTIVE' ORDER BY iata_code"),
      db.query("SELECT aircraft_id id, registration_no code, model, status, coalesce(seat_capacity,(SELECT count(*) FROM seats s WHERE s.aircraft_id=a.aircraft_id AND s.status='ACTIVE')::int) seats FROM aircraft a ORDER BY registration_no"),
      db.query("SELECT code, name, status FROM fare_classes ORDER BY code"),
    ]);
    res.json({ airports: airports.rows, aircraft: aircraft.rows, fareClasses: fareClasses.rows });
  } catch (e) { next(e); }
});

// =====================================================================
// CHUYẾN BAY
// =====================================================================
const FLIGHT_SELECT = `
  SELECT f.flight_id id, f.flight_no "flightNo", ao.iata_code origin, ao.city "originCity", ad.iata_code destination, ad.city "destinationCity",
         f.departure_time "departureTime", f.arrival_time "arrivalTime", f.aircraft_id "aircraftId", a.registration_no aircraft, f.status,
         coalesce(fi.available_seats,0) "availableSeats",
         coalesce((SELECT json_agg(json_build_object('code',fc.code,'name',fc.name,'price',ff.price::float,'quota',ff.quota) ORDER BY fc.code)
                   FROM flight_fares ff JOIN fare_classes fc ON fc.fare_class_id=ff.fare_class_id WHERE ff.flight_id=f.flight_id),'[]'::json) fares
  FROM flights f
  JOIN airports ao ON ao.airport_id=f.origin_id
  JOIN airports ad ON ad.airport_id=f.destination_id
  LEFT JOIN aircraft a ON a.aircraft_id=f.aircraft_id
  LEFT JOIN flight_inventory fi ON fi.flight_id=f.flight_id`;

const flightSchema = z.object({
  flightNo: z.string().trim().min(2).max(12).transform((s) => s.toUpperCase()),
  origin: z.string().trim().length(3).transform((s) => s.toUpperCase()),
  destination: z.string().trim().length(3).transform((s) => s.toUpperCase()),
  departureTime: iso,
  arrivalTime: iso,
  aircraftId: uuid.nullish(),
  status: z.enum(['OPEN_FOR_SALE', 'CLOSED', 'CANCELLED']).default('OPEN_FOR_SALE'),
  fares: z.array(z.object({ code: z.string().trim().min(1), price: z.number().min(0), quota: z.number().int().min(0) })).default([]),
}).refine((v) => v.origin !== v.destination, { path: ['destination'], message: 'Điểm đến phải khác điểm đi.' })
  .refine((v) => new Date(v.arrivalTime) > new Date(v.departureTime), { path: ['arrivalTime'], message: 'Giờ đến phải sau giờ khởi hành.' });

async function writeFlight(c, id, v) {
  const ids = (await c.query('SELECT iata_code, airport_id FROM airports WHERE iata_code = ANY($1)', [[v.origin, v.destination]])).rows;
  const o = ids.find((r) => r.iata_code === v.origin), d = ids.find((r) => r.iata_code === v.destination);
  if (!o || !d) throw httpErr(422, 'AIRPORT_UNKNOWN', 'Sân bay không tồn tại trong database.');
  if (v.aircraftId && !(await c.query('SELECT 1 FROM aircraft WHERE aircraft_id=$1', [v.aircraftId])).rowCount) throw httpErr(422, 'AIRCRAFT_UNKNOWN', 'Máy bay không tồn tại.');
  let flightId = id;
  if (id) {
    const r = await c.query('UPDATE flights SET flight_no=$2,origin_id=$3,destination_id=$4,aircraft_id=$5,departure_time=$6,arrival_time=$7,status=$8,version=version+1 WHERE flight_id=$1 RETURNING flight_id',
      [id, v.flightNo, o.airport_id, d.airport_id, v.aircraftId || null, v.departureTime, v.arrivalTime, v.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy chuyến bay.');
  } else {
    flightId = (await c.query("INSERT INTO flights(flight_no,origin_id,destination_id,aircraft_id,departure_time,arrival_time,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING flight_id",
      [v.flightNo, o.airport_id, d.airport_id, v.aircraftId || null, v.departureTime, v.arrivalTime, v.status])).rows[0].flight_id;
  }
  for (const f of v.fares) {
    const r = await c.query("INSERT INTO flight_fares(flight_id,fare_class_id,price,quota,status) SELECT $1,fare_class_id,$3,$4,'ACTIVE' FROM fare_classes WHERE code=$2 ON CONFLICT(flight_id,fare_class_id) DO UPDATE SET price=excluded.price,quota=excluded.quota,status='ACTIVE'",
      [flightId, f.code, f.price, f.quota]);
    if (!r.rowCount) throw httpErr(422, 'FARE_CLASS_UNKNOWN', `Hạng vé ${f.code} không tồn tại.`);
  }
  // Hạng vé bị bỏ trống giá trên form -> ngừng bán hạng đó cho chuyến này (giữ lại dòng để không ảnh hưởng vé đã bán)
  await c.query("UPDATE flight_fares ff SET status='INACTIVE' FROM fare_classes fc WHERE fc.fare_class_id=ff.fare_class_id AND ff.flight_id=$1 AND NOT (fc.code = ANY($2))", [flightId, v.fares.map((f) => f.code)]);
  // Số chỗ của chuyến = sức chứa máy bay (Quản lý máy bay); chưa khai báo thì lấy tổng số chỗ các hạng vé. Trừ chỗ đã bán.
  let seats = v.aircraftId ? (await c.query("SELECT coalesce(seat_capacity,(SELECT count(*)::int FROM seats s WHERE s.aircraft_id=a.aircraft_id AND s.status='ACTIVE'),0) n FROM aircraft a WHERE aircraft_id=$1", [v.aircraftId])).rows[0].n : 0;
  if (!seats) seats = v.fares.reduce((t, f) => t + f.quota, 0);
  const sold = (await c.query("SELECT count(*)::int n FROM passengers p JOIN booking_segments bs ON bs.booking_id=p.booking_id JOIN bookings b ON b.booking_id=p.booking_id WHERE bs.flight_id=$1 AND b.status='CONFIRMED'", [flightId])).rows[0].n;
  seats = Math.max(0, seats - sold);
  // Tuyến bay chưa có trong "Quản lý tuyến bay" thì tự thêm để 2 trang luôn khớp nhau
  await c.query('INSERT INTO routes(origin_id,destination_id,duration_min) VALUES($1,$2,$3) ON CONFLICT (origin_id,destination_id) DO NOTHING',
    [o.airport_id, d.airport_id, Math.max(1, Math.round((new Date(v.arrivalTime) - new Date(v.departureTime)) / 60000))]);
  await c.query('INSERT INTO flight_inventory(flight_id,available_seats) VALUES($1,$2) ON CONFLICT(flight_id) DO UPDATE SET available_seats=excluded.available_seats,updated_at=now(),version=flight_inventory.version+1', [flightId, seats]);
  return flightId;
}
const getFlight = async (id) => (await db.query(`${FLIGHT_SELECT} WHERE f.flight_id=$1`, [id])).rows[0];

// GET /admin/flights?page=1&size=20&q=VJ1&status=OPEN_FOR_SALE&date=2026-11-02&scope=upcoming|past|all
// Phân trang ở server (database có thể có hàng chục nghìn chuyến). Mặc định: chuyến sắp bay, gần nhất trước.
router.get('/flights', guard('flights.manage'), async (req, res, next) => {
  try {
    const size = Math.min(200, Math.max(1, +req.query.size || 20)), pageNo = Math.max(1, +req.query.page || 1);
    const params = []; const where = [];
    const scope = req.query.date ? 'all' : (req.query.scope || 'upcoming');
    if (scope === 'upcoming') where.push('f.departure_time >= now() - interval \'1 day\'');
    if (scope === 'past') where.push('f.departure_time < now()');
    if (req.query.date) { params.push(req.query.date); where.push(`(f.departure_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $${params.length}::date`); }
    if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where.push(`f.status = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim().toUpperCase()}%`);
      where.push(`(upper(f.flight_no) LIKE $${params.length} OR ao.iata_code LIKE $${params.length} OR ad.iata_code LIKE $${params.length} OR upper(coalesce(a.registration_no,'')) LIKE $${params.length} OR upper(ao.iata_code || '-' || ad.iata_code) LIKE $${params.length})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM flights f JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id LEFT JOIN aircraft a ON a.aircraft_id=f.aircraft_id`;
    const total = (await db.query(`SELECT count(*)::int n ${from} ${w}`, params)).rows[0].n;
    const order = scope === 'past' ? 'f.departure_time DESC' : 'f.departure_time ASC';
    const items = (await db.query(`${FLIGHT_SELECT} ${w} ORDER BY ${order} LIMIT ${size} OFFSET ${(pageNo - 1) * size}`, params)).rows;
    res.json({ items, total, page: pageNo, size });
  } catch (e) { next(e); }
});
router.post('/flights', guard('flights.manage'), validateBody(flightSchema), async (req, res, next) => {
  try { const id = await db.tx((c) => writeFlight(c, null, req.body)); res.status(201).json(await getFlight(id)); } catch (e) { next(e); }
});
router.patch('/flights/:id', guard('flights.manage'), validateBody(flightSchema), async (req, res, next) => {
  try { await db.tx((c) => writeFlight(c, req.params.id, req.body)); res.json(await getFlight(req.params.id)); } catch (e) { next(e); }
});
router.patch('/flights/:id/status', guard('flights.manage'), validateBody(z.object({ status: z.enum(['OPEN_FOR_SALE', 'CLOSED', 'CANCELLED']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE flights SET status=$2,version=version+1 WHERE flight_id=$1 RETURNING flight_id', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy chuyến bay.');
    res.json(await getFlight(req.params.id));
  } catch (e) { next(e); }
});
router.delete('/flights/:id', guard('flights.manage'), async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM flights WHERE flight_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy chuyến bay.');
    res.json({ message: 'Đã xóa chuyến bay.' });
  } catch (e) {
    if (e.code === '23503') return next(httpErr(409, 'FLIGHT_IN_USE', 'Chuyến bay đã có đặt chỗ/lịch sử nên không thể xóa. Hãy chuyển sang "Tạm dừng" hoặc "Đã hủy".'));
    next(e);
  }
});

// =====================================================================
// DỊCH VỤ BỔ SUNG
// =====================================================================
const SERVICE_SELECT = 'SELECT service_id id, code, type, name, base_price::float "basePrice", status, unit, description FROM ancillary_services';
const serviceSchema = z.object({
  code: z.string().trim().min(2).max(30).transform((s) => s.toUpperCase()),
  type: z.string().trim().min(2).max(30).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  basePrice: z.number().min(0),
  unit: z.string().trim().max(40).nullish(),
  description: z.string().trim().max(500).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});
router.get('/services', guard('services.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${SERVICE_SELECT} ORDER BY type, code`)).rows }); } catch (e) { next(e); }
});
router.post('/services', guard('services.manage'), validateBody(serviceSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query('INSERT INTO ancillary_services(code,type,name,base_price,status,unit,description) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING service_id',
      [v.code, v.type, v.name, v.basePrice, v.status, v.unit || null, v.description || null]);
    res.status(201).json((await db.query(`${SERVICE_SELECT} WHERE service_id=$1`, [r.rows[0].service_id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/services/:id', guard('services.manage'), validateBody(serviceSchema), async (req, res, next) => {
  try {
    const v = req.body;
    const r = await db.query('UPDATE ancillary_services SET code=$2,type=$3,name=$4,base_price=$5,status=$6,unit=$7,description=$8 WHERE service_id=$1 RETURNING service_id',
      [req.params.id, v.code, v.type, v.name, v.basePrice, v.status, v.unit || null, v.description || null]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy dịch vụ.');
    res.json((await db.query(`${SERVICE_SELECT} WHERE service_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/services/:id/status', guard('services.manage'), validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE ancillary_services SET status=$2 WHERE service_id=$1 RETURNING service_id', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy dịch vụ.');
    res.json((await db.query(`${SERVICE_SELECT} WHERE service_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.delete('/services/:id', guard('services.manage'), async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM ancillary_services WHERE service_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy dịch vụ.');
    res.json({ message: 'Đã xóa dịch vụ.' });
  } catch (e) {
    if (e.code === '23503') return next(httpErr(409, 'SERVICE_IN_USE', 'Dịch vụ đã được khách sử dụng nên không thể xóa. Hãy chuyển sang "Tạm dừng".'));
    next(e);
  }
});

// =====================================================================
// KHUYẾN MÃI
// =====================================================================
const PROMO_SELECT = `
  SELECT p.promotion_id id, p.code, p.name, p.discount_type "discountType", p.discount_value::float "discountValue", p.max_discount::float "maxDiscount",
         p.min_order::float "minOrder", p.starts_at "startsAt", p.ends_at "endsAt", p.usage_limit "usageLimit", p.per_user_limit "perUserLimit", p.status,
         CASE WHEN p.status='ACTIVE' AND p.ends_at<now() THEN 'EXPIRED' ELSE p.status END "effectiveStatus",
         (SELECT count(*)::int FROM promotion_usages u WHERE u.promotion_id=p.promotion_id) "usedCount"
  FROM promotions p`;
const promoSchema = z.object({
  code: z.string().trim().min(3).max(40).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(150),
  discountType: z.enum(['PERCENT', 'FIXED']),
  discountValue: z.number().positive(),
  maxDiscount: z.number().min(0).nullish(),
  minOrder: z.number().min(0).default(0),
  startsAt: iso,
  endsAt: iso,
  usageLimit: z.number().int().positive().nullish(),
  perUserLimit: z.number().int().min(1).default(1),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
}).refine((v) => v.discountType !== 'PERCENT' || v.discountValue <= 100, { path: ['discountValue'], message: 'Giảm theo phần trăm tối đa 100.' })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { path: ['endsAt'], message: 'Ngày kết thúc phải sau ngày bắt đầu.' });
const promoArgs = (v) => [v.code, v.name, v.discountType, v.discountValue, v.maxDiscount ?? null, v.minOrder, v.startsAt, v.endsAt, v.usageLimit ?? null, v.perUserLimit, v.status];

router.get('/promotions', guard('promotions.manage'), async (req, res, next) => {
  try { res.json({ items: (await db.query(`${PROMO_SELECT} ORDER BY p.starts_at DESC`)).rows }); } catch (e) { next(e); }
});
router.post('/promotions', guard('promotions.manage'), validateBody(promoSchema), async (req, res, next) => {
  try {
    const r = await db.query('INSERT INTO promotions(code,name,discount_type,discount_value,max_discount,min_order,starts_at,ends_at,usage_limit,per_user_limit,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING promotion_id', promoArgs(req.body));
    res.status(201).json((await db.query(`${PROMO_SELECT} WHERE p.promotion_id=$1`, [r.rows[0].promotion_id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/promotions/:id', guard('promotions.manage'), validateBody(promoSchema), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE promotions SET code=$2,name=$3,discount_type=$4,discount_value=$5,max_discount=$6,min_order=$7,starts_at=$8,ends_at=$9,usage_limit=$10,per_user_limit=$11,status=$12 WHERE promotion_id=$1 RETURNING promotion_id', [req.params.id, ...promoArgs(req.body)]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy khuyến mãi.');
    res.json((await db.query(`${PROMO_SELECT} WHERE p.promotion_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.patch('/promotions/:id/status', guard('promotions.manage'), validateBody(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })), async (req, res, next) => {
  try {
    const r = await db.query('UPDATE promotions SET status=$2 WHERE promotion_id=$1 RETURNING promotion_id', [req.params.id, req.body.status]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy khuyến mãi.');
    res.json((await db.query(`${PROMO_SELECT} WHERE p.promotion_id=$1`, [req.params.id])).rows[0]);
  } catch (e) { next(e); }
});
router.delete('/promotions/:id', guard('promotions.manage'), async (req, res, next) => {
  try {
    const r = await db.query('DELETE FROM promotions WHERE promotion_id=$1', [req.params.id]);
    if (!r.rowCount) throw httpErr(404, 'NOT_FOUND', 'Không tìm thấy khuyến mãi.');
    res.json({ message: 'Đã xóa khuyến mãi.' });
  } catch (e) {
    if (e.code === '23503') return next(httpErr(409, 'PROMOTION_IN_USE', 'Mã đã được khách sử dụng nên không thể xóa. Hãy chuyển sang "Tạm dừng".'));
    next(e);
  }
});

module.exports = router;
