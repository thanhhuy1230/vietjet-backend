// UC-00 Auth - Refresh token mức "core" (đã xác nhận ở Phase 2, mục 3): issue + revoke, KHÔNG rotation.
// Không lưu token gốc trong DB, chỉ lưu hash (giống pattern tham khảo Swift247, nhưng đơn giản hơn:
// không có cột replaced_by vì không làm rotation).
const crypto = require('crypto');
const db = require('../db');

const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);

const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');

async function issueRefreshToken(userId, client = db) {
  const raw = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await client.query(
    'INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,$3)',
    [userId, hash(raw), expiresAt]
  );
  return raw;
}

// Trả về user_id nếu token còn hợp lệ (tồn tại, chưa revoke, chưa hết hạn), null nếu không.
async function verifyRefreshToken(raw) {
  const q = await db.query(
    'SELECT user_id FROM refresh_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
    [hash(raw)]
  );
  return q.rows[0]?.user_id || null;
}

async function revokeRefreshToken(raw) {
  await db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hash(raw)]);
}

// Dùng khi đổi mật khẩu: thu hồi mọi phiên refresh cũ (đúng yêu cầu khóa luận mục 3.7).
async function revokeAllForUser(userId, client = db) {
  await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
}

module.exports = { issueRefreshToken, verifyRefreshToken, revokeRefreshToken, revokeAllForUser };
