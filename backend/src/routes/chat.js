// Hỗ trợ trực tuyến phía khách hàng: hội thoại + tin nhắn lưu ở chat_conversations / chat_messages.
// Nhân viên trả lời ở Admin Center (/api/v1/admin/chats). Khách chưa đăng nhập không chat được (cần biết là ai).
const router = require('express').Router();
const db = require('../db');
const { auth } = require('../middleware/auth');

const STAFF = (u) => u.role === 'ADMIN' || (u.role === 'SUPPORT' && (u.permissions || []).includes('chats.manage'));
const MSG_COLS = `m.message_id id, m.sender_type "senderType", m.body, m.sent_at "sentAt", m.read_at "readAt", su.full_name "senderName"`;

async function canAccess(conversationId, user) {
  const q = await db.query('SELECT user_id, status FROM chat_conversations WHERE conversation_id::text=$1', [String(conversationId)]);
  const c = q.rows[0];
  if (!c) return null;
  if (c.user_id === user.sub || STAFF(user)) return c;
  return null;
}

// POST /api/v1/chat/conversations - mở hội thoại; nếu khách đang có hội thoại chưa đóng thì dùng lại hội thoại đó
router.post('/conversations', auth(), async (req, res, next) => {
  try {
    const open = await db.query("SELECT conversation_id id, topic, status, created_at \"createdAt\" FROM chat_conversations WHERE user_id=$1 AND status<>'CLOSED' ORDER BY updated_at DESC LIMIT 1", [req.user.sub]);
    if (open.rows[0] && !req.body?.forceNew) return res.json(open.rows[0]);
    let bookingId = null;
    if (req.body?.bookingId) {
      const b = await db.query('SELECT booking_id FROM bookings WHERE booking_id::text=$1 AND user_id=$2', [String(req.body.bookingId), req.user.sub]);
      bookingId = b.rows[0]?.booking_id || null;
    }
    const q = await db.query("INSERT INTO chat_conversations(user_id,booking_id,topic,status) VALUES($1,$2,$3,'OPEN') RETURNING conversation_id id, topic, status, created_at \"createdAt\"",
      [req.user.sub, bookingId, String(req.body?.topic || 'Hỗ trợ chung').slice(0, 120)]);
    res.status(201).json(q.rows[0]);
  } catch (e) { next(e); }
});

router.get('/conversations', auth(), async (req, res, next) => {
  try {
    const q = await db.query('SELECT conversation_id id, booking_id "bookingId", topic, status, updated_at "updatedAt" FROM chat_conversations WHERE user_id=$1 ORDER BY updated_at DESC', [req.user.sub]);
    res.json({ items: q.rows });
  } catch (e) { next(e); }
});

router.get('/conversations/:id/messages', auth(), async (req, res, next) => {
  try {
    const c = await canAccess(req.params.id, req.user);
    if (!c) return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hội thoại.' });
    const q = await db.query(`SELECT ${MSG_COLS} FROM chat_messages m LEFT JOIN users su ON su.user_id=m.sender_id WHERE m.conversation_id::text=$1 ORDER BY m.sent_at`, [String(req.params.id)]);
    // Khách mở hội thoại -> đánh dấu đã đọc các tin của nhân viên
    if (c.user_id === req.user.sub) await db.query("UPDATE chat_messages SET read_at=now() WHERE conversation_id::text=$1 AND sender_type IN ('AGENT','BOT','SYSTEM') AND read_at IS NULL", [String(req.params.id)]);
    res.json({ status: c.status, items: q.rows });
  } catch (e) { next(e); }
});

router.post('/conversations/:id/messages', auth(), async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(422).json({ code: 'VALIDATION', message: 'Nội dung tin nhắn không được để trống.' });
    if (body.length > 2000) return res.status(422).json({ code: 'VALIDATION', message: 'Tin nhắn tối đa 2000 ký tự.' });
    const c = await canAccess(req.params.id, req.user);
    if (!c) return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hội thoại.' });
    const isOwner = c.user_id === req.user.sub;
    if (isOwner && c.status === 'CLOSED') return res.status(409).json({ code: 'CONVERSATION_CLOSED', message: 'Hội thoại đã đóng, vui lòng mở hội thoại mới.' });
    const type = isOwner ? 'CUSTOMER' : 'AGENT';
    const q = await db.query('INSERT INTO chat_messages(conversation_id,sender_id,sender_type,body) VALUES($1,$2,$3,$4) RETURNING message_id id, sender_type "senderType", body, sent_at "sentAt"',
      [String(req.params.id), req.user.sub, type, body]);
    await db.query(`UPDATE chat_conversations SET updated_at=now(),
        status=CASE WHEN $2='AGENT' AND status='OPEN' THEN 'IN_PROGRESS' ELSE status END,
        assigned_agent_id=CASE WHEN $2='AGENT' AND assigned_agent_id IS NULL THEN $3::uuid ELSE assigned_agent_id END
      WHERE conversation_id::text=$1`, [String(req.params.id), type, req.user.sub]);
    res.status(201).json(q.rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
