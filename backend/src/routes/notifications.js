// Thông báo của khách hàng (do hệ thống tạo khi đặt/hủy vé, hoặc nhân viên gửi từ Admin Center).
// Thông báo hẹn giờ (scheduled_at) chỉ hiện khi tới giờ; thông báo đã bị admin hủy không hiện.
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');

const VISIBLE = "user_id=$1 AND status<>'CANCELLED' AND (scheduled_at IS NULL OR scheduled_at<=now())";

router.get('/', auth(), async (req, res, next) => {
  try {
    // Thông báo hẹn giờ đã tới giờ -> chuyển SENT
    await db.query("UPDATE notifications SET status='SENT', sent_at=coalesce(sent_at,now()) WHERE user_id=$1 AND status='QUEUED' AND scheduled_at<=now()", [req.user.sub]);
    const q = await db.query(`SELECT notification_id id, type, title, body, data, status, coalesce(sent_at, created_at) "createdAt", read_at "readAt"
      FROM notifications WHERE ${VISIBLE} ORDER BY coalesce(sent_at, created_at) DESC LIMIT 100`, [req.user.sub]);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

router.patch('/:id/read', auth(), async (req, res, next) => {
  try {
    const q = await db.query('UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE notification_id::text=$2 AND user_id=$1 RETURNING notification_id id, read_at "readAt"', [req.user.sub, String(req.params.id)]);
    if (!q.rowCount) return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    res.json(q.rows[0]);
  } catch (e) { next(e); }
});

router.post('/read-all', auth(), async (req, res, next) => {
  try {
    const q = await db.query(`UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE ${VISIBLE} AND read_at IS NULL`, [req.user.sub]);
    res.json({ updated: q.rowCount });
  } catch (e) { next(e); }
});

module.exports = router;
