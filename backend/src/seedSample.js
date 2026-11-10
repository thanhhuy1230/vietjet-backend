// npm run seed:sample            -> tạo dữ liệu mẫu cho các trang Admin (khách hàng, nhân viên, booking & doanh thu
//                                    6 tháng gần nhất, vé, đánh giá, hội thoại, thông báo). Chỉ chạy 1 lần, chạy lại sẽ bỏ qua.
// npm run seed:sample -- --reset -> xóa dữ liệu mẫu đã tạo rồi tạo lại.
// Dữ liệu mẫu nhận biết bằng: email khách *@demo.vietjet.vn, chuyến bay quá khứ số hiệu VJ7xx.
// Yêu cầu: đã chạy `npm run migrate` và `npm run seed` (sân bay, hạng vé, dịch vụ, tài khoản admin).
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const DEMO_DOMAIN = '@demo.vietjet.vn';
const RESET = process.argv.includes('--reset');

// Số ngẫu nhiên có hạt giống -> mỗi lần tạo ra cùng một bộ dữ liệu
let seed = 20261102;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const DAY = 86400000;
const pnr = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[int(0, 31)]).join('');
const ticketNo = () => `981${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

const FAMILY = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương'];
const GIVEN = ['Minh Anh', 'Thu Hà', 'Quốc Bảo', 'Gia Huy', 'Ngọc Lan', 'Đức Thắng', 'Thanh Tâm', 'Hải Yến', 'Tuấn Kiệt', 'Mai Phương', 'Hoàng Nam', 'Bảo Ngọc', 'Văn Long', 'Khánh Linh', 'Phúc An', 'Thùy Dung', 'Trọng Nhân', 'Hồng Nhung'];
const TOWNS = ['Hà Nội', 'TP. Hồ Chí Minh', 'Đà Nẵng', 'Hải Phòng', 'Cần Thơ', 'Nghệ An', 'Thanh Hóa', 'Huế', 'Khánh Hòa', 'Lâm Đồng'];
const REVIEWS = [
  [5, 'Chuyến bay đúng giờ, tiếp viên thân thiện, ghế ngồi sạch sẽ. Sẽ tiếp tục ủng hộ Vietjet.'],
  [5, 'Thủ tục check-in online rất nhanh, lên máy bay không phải chờ lâu.'],
  [4, 'Bay êm, cất cánh đúng giờ. Suất ăn hơi ít nhưng nhìn chung hài lòng.'],
  [4, 'Giá vé hợp lý, nhân viên mặt đất hỗ trợ nhiệt tình khi tôi đổi chỗ ngồi.'],
  [3, 'Chuyến bay trễ khoảng 30 phút, có thông báo nhưng hơi muộn.'],
  [3, 'Ổn so với giá tiền, chỗ để chân hơi chật với người cao.'],
  [2, 'Hành lý ký gửi ra băng chuyền khá chậm, phải đợi gần 40 phút.'],
  [5, 'Đặt vé trên app dễ dàng, chọn ghế và mua thêm hành lý rất tiện.'],
  [1, 'Chuyến bay bị đổi giờ sát ngày bay, tôi phải sắp xếp lại lịch làm việc.'],
  [4, 'Máy bay mới, sạch sẽ. Tiếp viên hướng dẫn an toàn rõ ràng.'],
];
const REPLIES = ['Cảm ơn quý khách đã tin tưởng lựa chọn Vietjet. Hẹn gặp lại quý khách trên những chuyến bay tiếp theo!', 'Vietjet thành thật xin lỗi vì sự bất tiện. Chúng tôi đã ghi nhận và sẽ cải thiện chất lượng phục vụ.', 'Cảm ơn góp ý của quý khách, bộ phận khai thác đã được thông báo để khắc phục.'];
const CHATS = [
  ['Hành lý', 'Cho mình hỏi vé Eco được mang bao nhiêu kg hành lý xách tay ạ?', 'Chào anh/chị, vé Eco được mang 7kg hành lý xách tay. Anh/chị có thể mua thêm hành lý ký gửi trong mục Dịch vụ ạ.'],
  ['Đổi vé', 'Tôi muốn đổi ngày bay sang tuần sau thì phí thế nào?', 'Dạ, phí đổi vé tùy hạng vé và chênh lệch giá. Anh/chị gửi giúp em mã đặt chỗ để em kiểm tra cụ thể ạ.'],
  ['Hoàn vé', 'Mình đã hủy vé hôm qua, khi nào tiền được hoàn về tài khoản?', null],
  ['Check-in', 'App báo chưa mở check-in, chuyến của tôi bay lúc 6h sáng mai.', 'Check-in trực tuyến mở trước giờ bay 24 tiếng ạ. Anh/chị vui lòng thử lại sau 6h sáng nay nhé.'],
  ['Thanh toán', 'Thanh toán VNPAY bị trừ tiền nhưng booking vẫn chờ thanh toán?', null],
  ['Hỗ trợ chung', 'Trẻ em 5 tuổi có cần giấy tờ gì khi bay nội địa không?', 'Trẻ em dưới 14 tuổi cần giấy khai sinh (bản chính hoặc bản sao công chứng) ạ.'],
];

async function q(sql, params) { return pool.query(sql, params); }

async function reset(c) {
  const demoUsers = `SELECT user_id FROM users WHERE email LIKE '%${DEMO_DOMAIN}'`;
  const demoBookings = `SELECT booking_id FROM bookings WHERE user_id IN (${demoUsers})`;
  const demoTickets = `SELECT t.ticket_id FROM tickets t JOIN booking_segments bs ON bs.segment_id=t.segment_id WHERE bs.booking_id IN (${demoBookings})`;
  const stmts = [
    `DELETE FROM reviews WHERE user_id IN (${demoUsers})`,
    `DELETE FROM boarding_passes WHERE check_in_id IN (SELECT check_in_id FROM check_ins WHERE ticket_id IN (${demoTickets}))`,
    `DELETE FROM check_ins WHERE ticket_id IN (${demoTickets})`,
    `DELETE FROM refund_items WHERE refund_id IN (SELECT refund_id FROM refund_requests WHERE booking_id IN (${demoBookings}))`,
    `DELETE FROM refund_events WHERE refund_id IN (SELECT refund_id FROM refund_requests WHERE booking_id IN (${demoBookings}))`,
    `DELETE FROM refund_requests WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM payment_events WHERE payment_id IN (SELECT payment_id FROM payments WHERE booking_id IN (${demoBookings}))`,
    `DELETE FROM payments WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM promotion_usages WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM tickets WHERE ticket_id IN (${demoTickets})`,
    `DELETE FROM booking_services WHERE segment_id IN (SELECT segment_id FROM booking_segments WHERE booking_id IN (${demoBookings}))`,
    `DELETE FROM booking_seats WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM notifications WHERE user_id IN (${demoUsers})`,
    `DELETE FROM passengers WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM booking_segments WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM bookings WHERE booking_id IN (${demoBookings})`,
    `DELETE FROM chat_conversations WHERE user_id IN (${demoUsers})`,
    `DELETE FROM users WHERE user_id IN (${demoUsers})`,
    "DELETE FROM users WHERE email IN ('cskh@vietjet.local','dieuhanh@vietjet.local') AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.sender_id=users.user_id)",
    "DELETE FROM flights f WHERE f.flight_no LIKE 'VJ7%' AND f.departure_time < now() AND NOT EXISTS (SELECT 1 FROM booking_segments bs WHERE bs.flight_id=f.flight_id)",
  ];
  for (const s of stmts) await c.query(s);
}

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (RESET) { await reset(c); console.log('Đã xóa dữ liệu mẫu cũ.'); }
    else if ((await c.query(`SELECT 1 FROM users WHERE email LIKE '%${DEMO_DOMAIN}' LIMIT 1`)).rowCount) {
      console.log('Dữ liệu mẫu đã có sẵn - bỏ qua. (Muốn tạo lại: npm run seed:sample -- --reset)');
      await c.query('ROLLBACK'); return;
    }

    // ---------- Danh mục bắt buộc ----------
    const airports = (await c.query("SELECT airport_id id, iata_code code FROM airports WHERE status='ACTIVE'")).rows;
    const fares = (await c.query('SELECT fare_class_id id, code FROM fare_classes')).rows;
    const services = (await c.query("SELECT service_id id, base_price::float price, unit FROM ancillary_services WHERE status='ACTIVE'")).rows;
    const roleIds = Object.fromEntries((await c.query('SELECT code, role_id FROM roles')).rows.map((r) => [r.code, r.role_id]));
    const admin = (await c.query("SELECT u.user_id FROM users u JOIN user_roles ur ON ur.user_id=u.user_id JOIN roles r ON r.role_id=ur.role_id WHERE r.code='ADMIN' ORDER BY u.created_at LIMIT 1")).rows[0];
    if (airports.length < 2 || !fares.length || !roleIds.CUSTOMER) throw new Error('Thiếu dữ liệu nền (sân bay / hạng vé / vai trò). Hãy chạy `npm run seed` trước.');
    let aircraft = (await c.query("SELECT aircraft_id id FROM aircraft ORDER BY registration_no LIMIT 1")).rows[0];
    if (!aircraft) aircraft = (await c.query("INSERT INTO aircraft(registration_no,model,status,seat_capacity) VALUES('VN-A688','Airbus A321neo','ACTIVE',230) RETURNING aircraft_id id")).rows[0];
    const fareBy = Object.fromEntries(fares.map((f) => [f.code, f.id]));
    const fareList = ['ECO', 'DELUXE', 'SKYBOSS'].filter((k) => fareBy[k]);
    if (!fareList.length) fareList.push(fares[0].code);
    const BASE = { ECO: [690000, 1290000], DELUXE: [990000, 1790000], SKYBOSS: [1890000, 3290000] };

    // ---------- Nhân viên hỗ trợ ----------
    const pw = await bcrypt.hash('Vietjet@123', 10);
    const staff = [];
    for (const [email, name, perms] of [
      ['cskh@vietjet.local', 'Nguyễn Thị CSKH', ['customers.manage', 'chats.manage', 'reviews.manage', 'notifications.manage']],
      ['dieuhanh@vietjet.local', 'Trần Văn Điều Hành', ['flights.manage', 'routes.manage', 'aircraft.manage']],
    ]) {
      let u = (await c.query('SELECT user_id FROM users WHERE lower(email)=$1', [email])).rows[0];
      if (!u) {
        u = (await c.query("INSERT INTO users(email,password_hash,full_name,status,created_at) VALUES($1,$2,$3,'ACTIVE',now()-interval '200 days') RETURNING user_id", [email, pw, name])).rows[0];
        await c.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [u.user_id, roleIds.SUPPORT]);
        await c.query('INSERT INTO user_permissions(user_id,permission_id) SELECT $1,permission_id FROM permissions WHERE code=ANY($2) ON CONFLICT DO NOTHING', [u.user_id, perms]);
      }
      staff.push(u.user_id);
    }
    const agentId = staff[0];

    // ---------- Khách hàng ----------
    const customers = [];
    for (let i = 0; i < 18; i++) {
      const fam = FAMILY[i % FAMILY.length], giv = GIVEN[i % GIVEN.length];
      const created = new Date(Date.now() - int(5, 240) * DAY);
      const u = (await c.query(`INSERT INTO users(email,full_name,phone,status,date_of_birth,hometown,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING user_id`,
        [`khach${String(i + 1).padStart(2, '0')}${DEMO_DOMAIN}`, `${fam} ${giv}`, `0912${String(100000 + i * 7919).slice(-6)}`, i === 17 ? 'INACTIVE' : 'ACTIVE',
          `${int(1965, 2004)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`, pick(TOWNS), created])).rows[0];
      await c.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [u.user_id, roleIds.CUSTOMER]);
      customers.push({ id: u.user_id, name: `${fam} ${giv}`, created });
    }

    // ---------- Chuyến bay đã bay (6 tháng gần nhất) ----------
    const codes = airports.map((a) => a.code);
    const pairs = [];
    for (const a of ['HAN', 'SGN']) for (const b of ['SGN', 'HAN', 'DAD', 'CXR', 'PQC']) if (a !== b && codes.includes(a) && codes.includes(b)) pairs.push([a, b]);
    if (!pairs.length) pairs.push([codes[0], codes[1]]);
    const apId = Object.fromEntries(airports.map((a) => [a.code, a.id]));
    const now = Date.now();
    const start = new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1).getTime();
    const flights = [];
    let fno = 700;
    for (let t = start + 2 * DAY; t < now - DAY; t += int(3, 5) * DAY) {
      for (let k = 0; k < 2; k++) {
        const [o, d] = pick(pairs);
        const dep = new Date(t + int(6, 20) * 3600000);
        const arr = new Date(dep.getTime() + int(65, 130) * 60000);
        const flightNo = `VJ7${String(fno++ % 100).padStart(2, '0')}`;
        const f = (await c.query("INSERT INTO flights(flight_no,origin_id,destination_id,aircraft_id,departure_time,arrival_time,status) VALUES($1,$2,$3,$4,$5,$6,'CLOSED') ON CONFLICT (flight_no,departure_time) DO NOTHING RETURNING flight_id", [flightNo, apId[o], apId[d], aircraft.id, dep, arr])).rows[0];
        if (!f) continue;
        const prices = {};
        for (const code of fareList) { const [lo, hi] = BASE[code] || [800000, 1500000]; prices[code] = Math.round((lo + rnd() * (hi - lo)) / 10000) * 10000; await c.query("INSERT INTO flight_fares(flight_id,fare_class_id,price,quota,status) VALUES($1,$2,$3,$4,'ACTIVE')", [f.flight_id, fareBy[code], prices[code], code === 'SKYBOSS' ? 12 : 80]); }
        await c.query('INSERT INTO flight_inventory(flight_id,available_seats) VALUES($1,180)', [f.flight_id]);
        await c.query('INSERT INTO routes(origin_id,destination_id,duration_min) VALUES($1,$2,$3) ON CONFLICT (origin_id,destination_id) DO NOTHING', [apId[o], apId[d], Math.round((arr - dep) / 60000)]);
        flights.push({ id: f.flight_id, dep, arr, prices, past: true });
      }
    }
    // Chuyến sắp bay (đã có từ seed-flights) -> thêm booking đặt trong tháng này
    const upcoming = (await c.query(`SELECT f.flight_id id, f.departure_time dep, f.arrival_time arr,
        jsonb_object_agg(fc.code, ff.price) prices FROM flights f JOIN flight_fares ff ON ff.flight_id=f.flight_id JOIN fare_classes fc ON fc.fare_class_id=ff.fare_class_id
       WHERE f.departure_time BETWEEN now()+interval '2 days' AND now()+interval '30 days' AND f.status='OPEN_FOR_SALE'
       GROUP BY f.flight_id ORDER BY random() LIMIT 12`)).rows.map((r) => ({ ...r, prices: Object.fromEntries(Object.entries(r.prices).map(([k, v]) => [k, +v])), past: false }));
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

    // ---------- Booking + thanh toán + vé ----------
    const flownTickets = [];
    let bookingCount = 0, revenue = 0;
    for (const f of [...flights, ...upcoming]) {
      const n = f.past ? int(3, 8) : int(1, 3);
      for (let b = 0; b < n; b++) {
        const cust = pick(customers);
        const created = f.past ? new Date(Math.max(cust.created.getTime(), f.dep.getTime() - int(2, 30) * DAY)) : new Date(Math.min(now - 3600000, monthStart + rnd() * (now - monthStart)));
        if (created >= f.dep) continue;
        const code = pick(Object.keys(f.prices).filter((k) => fareBy[k]));
        if (!code) continue;
        const pax = int(1, 3), fare = f.prices[code];
        const svc = rnd() < 0.45 && services.length ? pick(services) : null;
        const subtotal = fare * pax;
        const total = subtotal + (svc ? svc.price * pax : 0);
        const cancelled = rnd() < 0.08;
        const bk = (await c.query(`INSERT INTO bookings(pnr,user_id,status,total_amount,confirmed_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5,$5) RETURNING booking_id`,
          [pnr(), cust.id, cancelled ? 'CANCELLED' : 'CONFIRMED', total, created])).rows[0];
        const seg = (await c.query('INSERT INTO booking_segments(booking_id,flight_id,fare_class_id,subtotal) VALUES($1,$2,$3,$4) RETURNING segment_id', [bk.booking_id, f.id, fareBy[code], subtotal])).rows[0];
        const payment = (await c.query(`INSERT INTO payments(booking_id,provider,amount,refunded_amount,status,idempotency_key,created_at) VALUES($1,$2,$3,$4,'SUCCEEDED',$5,$6) RETURNING payment_id`,
          [bk.booking_id, rnd() < 0.7 ? 'VNPAY' : 'DEMO', total, cancelled ? Math.round(total * 0.8) : 0, `seed-${crypto.randomUUID()}`, created])).rows[0];
        if (cancelled) await c.query("INSERT INTO refund_requests(booking_id,payment_id,amount,fee,status,requested_at) VALUES($1,$2,$3,$4,$5,$6)", [bk.booking_id, payment.payment_id, Math.round(total * 0.8), Math.round(total * 0.2), rnd() < 0.5 ? 'REQUESTED' : 'COMPLETED', new Date(created.getTime() + DAY)]);
        for (let p = 0; p < pax; p++) {
          const name = p === 0 ? cust.name : `${pick(FAMILY)} ${pick(GIVEN)}`;
          const ps = (await c.query("INSERT INTO passengers(booking_id,full_name,nationality) VALUES($1,$2,'VN') RETURNING passenger_id", [bk.booking_id, name])).rows[0];
          if (svc) await c.query('INSERT INTO booking_services(segment_id,passenger_id,service_id,qty,unit_price) VALUES($1,$2,$3,1,$4)', [seg.segment_id, ps.passenger_id, svc.id, svc.price]);
          const status = cancelled ? 'CANCELLED' : f.past ? 'FLOWN' : 'ISSUED';
          const tk = (await c.query('INSERT INTO tickets(ticket_no,segment_id,passenger_id,status,fare_snapshot,issued_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING ticket_id', [ticketNo(), seg.segment_id, ps.passenger_id, status, JSON.stringify({ fareClass: code, price: fare }), created])).rows[0];
          if (p === 0 && f.past && !cancelled) flownTickets.push({ ticket: tk.ticket_id, user: cust.id, arr: f.arr });
        }
        if (!cancelled) {
          await c.query('UPDATE flight_fares SET quota=greatest(0,quota-$3) WHERE flight_id=$1 AND fare_class_id=$2', [f.id, fareBy[code], pax]);
          await c.query('UPDATE flight_inventory SET available_seats=greatest(0,available_seats-$2) WHERE flight_id=$1', [f.id, pax]);
          await c.query("INSERT INTO notifications(user_id,booking_id,type,title,body,status,sent_at,read_at,created_at) VALUES($1,$2,'BOOKING_CONFIRMED','Đặt vé thành công',$3,'SENT',$4,$5,$4)",
            [cust.id, bk.booking_id, 'Thanh toán thành công. Vé điện tử đã được lưu trong mục Chuyến bay của tôi.', created, rnd() < 0.7 ? created : null]);
          revenue += total;
        }
        bookingCount++;
      }
    }

    // ---------- Đánh giá ----------
    let reviewCount = 0;
    for (const t of flownTickets) {
      if (rnd() > 0.45) continue;
      const [rating, content] = pick(REVIEWS);
      const created = new Date(t.arr.getTime() + int(2, 72) * 3600000);
      if (created > now) continue;
      const status = rating <= 2 ? 'NEEDS_REPLY' : pick(['APPROVED', 'APPROVED', 'APPROVED', 'PENDING', 'HIDDEN']);
      const reply = status === 'APPROVED' && rnd() < 0.5 ? (rating >= 4 ? REPLIES[0] : REPLIES[2]) : null;
      await c.query('INSERT INTO reviews(user_id,ticket_id,rating,content,status,admin_reply,created_at,moderated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [t.user, t.ticket, rating, content, status, reply, created, status === 'PENDING' ? null : new Date(created.getTime() + DAY)]);
      reviewCount++;
    }

    // ---------- Hội thoại hỗ trợ ----------
    for (const [i, [topic, ask, answer]] of CHATS.entries()) {
      const cust = customers[i * 2];
      const at = new Date(now - int(1, 20) * DAY - int(0, 600) * 60000);
      const status = answer ? (i % 3 === 0 ? 'CLOSED' : 'IN_PROGRESS') : 'OPEN';
      const conv = (await c.query('INSERT INTO chat_conversations(user_id,topic,status,assigned_agent_id,created_at,updated_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING conversation_id',
        [cust.id, topic, status, answer ? agentId : null, at, new Date(at.getTime() + 20 * 60000), status === 'CLOSED' ? new Date(at.getTime() + 3600000) : null])).rows[0];
      await c.query("INSERT INTO chat_messages(conversation_id,sender_id,sender_type,body,sent_at,read_at) VALUES($1,$2,'CUSTOMER',$3,$4,$5)", [conv.conversation_id, cust.id, ask, at, answer ? at : null]);
      if (answer) await c.query("INSERT INTO chat_messages(conversation_id,sender_id,sender_type,body,sent_at,read_at) VALUES($1,$2,'AGENT',$3,$4,$4)", [conv.conversation_id, agentId, answer, new Date(at.getTime() + 12 * 60000)]);
    }

    // ---------- Thông báo gửi hàng loạt (1 đã gửi, 1 hẹn giờ) ----------
    const active = customers.filter((x, i) => i !== 17).map((x) => x.id);
    for (const [title, body, type, offsetDays] of [
      ['Flash Sale cuối tuần - giảm đến 30%', 'Săn vé 0 đồng và giảm đến 30% cho các chặng nội địa. Áp dụng từ thứ Sáu đến Chủ nhật.', 'PROMOTION', -18],
      ['Thay đổi quy định hành lý xách tay', 'Từ tháng sau, hành lý xách tay tối đa 7kg và 1 phụ kiện cá nhân. Vui lòng kiểm tra trước khi ra sân bay.', 'SYSTEM', -6],
      ['Nhắc lịch: Ưu đãi Tết sắp mở bán', 'Vé Tết mở bán vào 9h sáng ngày mai. Bật thông báo để không bỏ lỡ giá tốt.', 'PROMOTION', 3],
    ]) {
      const when = new Date(now + offsetDays * DAY);
      const scheduled = offsetDays > 0;
      await c.query(`INSERT INTO notifications(user_id,type,title,body,status,scheduled_at,sent_at,read_at,campaign_id,created_by,created_at)
        SELECT x,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,CASE WHEN NOT $8::boolean AND random()<0.5 THEN $7::timestamptz END,$9::uuid,$10::uuid,$11::timestamptz FROM unnest($1::uuid[]) x`,
        [active, type, title, body, scheduled ? 'QUEUED' : 'SENT', scheduled ? when : null, scheduled ? null : when, scheduled, crypto.randomUUID(), admin?.user_id || null, scheduled ? new Date(now) : when]);
    }

    await c.query('COMMIT');
    console.log('Đã tạo dữ liệu mẫu:');
    console.log(`  ${customers.length} khách hàng (*${DEMO_DOMAIN}), 2 nhân viên (cskh@vietjet.local, dieuhanh@vietjet.local / Vietjet@123)`);
    console.log(`  ${flights.length} chuyến bay đã bay (6 tháng gần nhất), ${bookingCount} booking, doanh thu ~${Math.round(revenue).toLocaleString('vi-VN')} ₫`);
    console.log(`  ${reviewCount} đánh giá, ${CHATS.length} hội thoại, 3 chiến dịch thông báo`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); await pool.end(); }
})().catch((e) => { console.error('Lỗi tạo dữ liệu mẫu:', e.message); process.exit(1); });
