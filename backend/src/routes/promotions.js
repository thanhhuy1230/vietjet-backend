// Khuyến mãi phía khách hàng - dữ liệu lấy trực tiếp từ bảng promotions (do Admin Center quản lý).
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');

const PUBLIC_COLS = `promotion_id id, code, name title, discount_type type, discount_value::float value, max_discount::float max,
  min_order::float "minOrder", starts_at "startsAt", ends_at, ends_at "endsAt", usage_limit "usageLimit", per_user_limit "perUserLimit"`;

// GET /api/v1/promotions/active - mã đang chạy (ACTIVE, trong thời hạn, còn lượt)
router.get('/active', async (req, res, next) => {
  try {
    const q = await db.query(`SELECT ${PUBLIC_COLS} FROM promotions p
      WHERE status='ACTIVE' AND now() BETWEEN starts_at AND ends_at
        AND (usage_limit IS NULL OR usage_limit > (SELECT count(*) FROM promotion_usages u JOIN bookings b ON b.booking_id=u.booking_id WHERE u.promotion_id=p.promotion_id AND b.status<>'CANCELLED'))
      ORDER BY ends_at ASC`);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

// POST /api/v1/promotions/validate { code, subtotal } - kiểm tra mã + tính số tiền giảm (cùng logic với lúc đặt vé)
router.post('/validate', auth(false), async (req, res, next) => {
  try {
    const { checkPromotion } = require('./bookings');
    const code = String(req.body?.code || '').trim();
    const subtotal = Math.max(0, Number(req.body?.subtotal) || 0);
    if (!code) return res.status(422).json({ code: 'VALIDATION', message: 'Vui lòng nhập mã khuyến mãi.' });
    const { promo: p, discount } = await checkPromotion(db, code, subtotal, req.user?.sub || null);
    res.json({
      valid: true, promotionId: p.promotion_id, code: p.code, title: p.name, type: p.discount_type, value: +p.discount_value,
      max: p.max_discount === null ? null : +p.max_discount, minOrder: +p.min_order, discount, total: Math.max(0, subtotal - discount),
    });
  } catch (e) { next(e); }
});

module.exports = router;
