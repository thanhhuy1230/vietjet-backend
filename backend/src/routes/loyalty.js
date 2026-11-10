// SkyJoy - API phía khách hàng (cần đăng nhập). Nghiệp vụ ở utils/loyalty.js.
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');
const loyalty = require('../utils/loyalty');

const TYPE_LABEL = { EARN: 'Tích điểm', REDEEM: 'Dùng điểm', REFUND: 'Hoàn điểm', ADJUST: 'Điều chỉnh' };
const STATUS_LABEL = { PENDING: 'Chờ cộng', AVAILABLE: 'Đã cộng', HELD: 'Đang giữ', CANCELLED: 'Đã hủy' };

// GET /api/v1/loyalty/me - thẻ hội viên: mã, hạng, điểm khả dụng / chờ cộng / đang giữ, tiến độ lên hạng, quy tắc
router.get('/me', auth(), async (req, res, next) => {
  try {
    const out = await db.tx(async (c) => {
      const memberNo = await loyalty.ensureAccount(c, req.user.sub);
      await loyalty.sync(c, req.user.sub);
      const sum = await loyalty.summary(c, req.user.sub);
      const since = (await c.query('SELECT created_at FROM loyalty_accounts WHERE user_id=$1', [req.user.sub])).rows[0].created_at;
      const cfg = loyalty.config();
      return {
        memberNo, memberSince: since, ...sum,
        rules: { earnPerVnd: cfg.earnPerVnd, pointValue: cfg.pointValue, minRedeem: cfg.minRedeem, maxRedeemRatio: cfg.maxRatio, tiers: cfg.tiers },
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// GET /api/v1/loyalty/transactions?page=1&size=20 - lịch sử điểm
router.get('/transactions', auth(), async (req, res, next) => {
  try {
    const size = Math.min(100, Math.max(1, +req.query.size || 20)), page = Math.max(1, +req.query.page || 1);
    await db.tx(async (c) => { await loyalty.ensureAccount(c, req.user.sub); await loyalty.sync(c, req.user.sub); });
    const total = (await db.query('SELECT count(*)::int n FROM loyalty_transactions WHERE user_id=$1', [req.user.sub])).rows[0].n;
    const q = await db.query(`SELECT t.txn_id id, t.type, t.points, t.status, t.note, t.available_at "availableAt", t.created_at "createdAt", b.pnr
      FROM loyalty_transactions t LEFT JOIN bookings b ON b.booking_id=t.booking_id
      WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, [req.user.sub]);
    res.json({ page, size, total, items: q.rows.map((r) => ({ ...r, typeLabel: TYPE_LABEL[r.type] || r.type, statusLabel: STATUS_LABEL[r.status] || r.status })) });
  } catch (e) { next(e); }
});

module.exports = router;
