// Danh mục công khai cho app khách hàng (web + mobile). Toàn bộ lấy từ PostgreSQL - Admin Center thêm/sửa là app thấy ngay.
const router = require('express').Router();
const db = require('../db');

// GET /api/v1/catalog/airports - sân bay đang hoạt động (ô chọn Điểm đi / Điểm đến)
router.get('/airports', async (req, res, next) => {
  try {
    const q = await db.query(`SELECT iata_code code, name, city, country,
        city || ' (' || iata_code || ')' label
      FROM airports WHERE status='ACTIVE' ORDER BY country <> 'Việt Nam', city`);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

// GET /api/v1/catalog/routes - tuyến bay đang mở (gợi ý điểm đến theo điểm đi)
router.get('/routes', async (req, res, next) => {
  try {
    const q = await db.query(`SELECT ao.iata_code "from", ad.iata_code "to", r.distance_km "distanceKm", r.duration_min "durationMin"
      FROM routes r JOIN airports ao ON ao.airport_id=r.origin_id JOIN airports ad ON ad.airport_id=r.destination_id
      WHERE r.status='ACTIVE' AND ao.status='ACTIVE' AND ad.status='ACTIVE' ORDER BY 1,2`);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

// GET /api/v1/catalog/services - dịch vụ bổ sung đang bán (màn Dịch vụ của app)
router.get('/services', async (req, res, next) => {
  try {
    const q = await db.query(`SELECT service_id id, code, type, name, base_price::float price, unit, description
      FROM ancillary_services WHERE status='ACTIVE' ORDER BY type, base_price`);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

// GET /api/v1/catalog/fare-classes - hạng vé và điều kiện (hành lý, đổi vé)
router.get('/fare-classes', async (req, res, next) => {
  try {
    const q = await db.query("SELECT fare_class_id id, code, name, conditions, description FROM fare_classes WHERE status='ACTIVE' ORDER BY code");
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

module.exports = router;
