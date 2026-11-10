require('dotenv').config();
const fs = require('fs'); const path = require('path'); const { pool } = require('./db');
// node src/seed.js          -> dữ liệu nền (seed.sql)
// node src/seed.js demo     -> dữ liệu mẫu tuỳ chọn (seed-demo.sql)
// node src/seed.js flights  -> chuyến bay mọi ngày đến 31/12/2027 cho app customer (seed-flights.sql)
const file = { demo: 'seed-demo.sql', flights: 'seed-flights.sql' }[process.argv[2]] || 'seed.sql';
(async () => {
  try {
    await pool.query(fs.readFileSync(path.resolve(__dirname, '../../database', file), 'utf8'));
    console.log(`Seed completed (${file})`);
  } finally { await pool.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
