// npm run migrate - tạo / đồng bộ cấu trúc database. Chạy lại nhiều lần an toàn, KHÔNG xóa dữ liệu.
//  - Database trống: chạy database/schema.sql rồi upgrade.sql
//  - Database đã có bảng (kể cả tạo từ script cũ / tạo tay trong pgAdmin): tự bổ sung bảng + cột còn thiếu
//    theo schema.sql và upgrade.sql, rồi in ra danh sách những gì đã thêm.
require('dotenv').config();
const fs = require('fs'); const path = require('path'); const { pool } = require('./db');
const { applyFile } = require('./schemaRepair');
const dir = path.resolve(__dirname, '../../database');

(async () => {
  const log = [];
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const { rows } = await pool.query("SELECT to_regclass('public.users') AS t");
    if (!rows[0].t) {
      await pool.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
      console.log('Đã tạo toàn bộ bảng (schema.sql).');
    } else {
      console.log('Database đã có bảng - kiểm tra và bổ sung bảng/cột còn thiếu theo schema.sql...');
      await applyFile(pool, path.join(dir, 'schema.sql'), log);
    }
    await applyFile(pool, path.join(dir, 'upgrade.sql'), log);
    if (log.length) { console.log('Đã đồng bộ cấu trúc database:'); for (const l of log) console.log('  ' + l); }
    else console.log('Cấu trúc database đã đầy đủ.');
    console.log('Migration completed.');
  } finally { await pool.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
