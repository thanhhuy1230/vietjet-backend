// Admin Center - DOANH THU (thay cho trang Tổng quan): doanh thu theo tháng, tổng hợp tháng đang xem,
// doanh thu từng chuyến bay và xuất file Excel (.xlsx). Quyền: revenue.view (Quản trị viên luôn có).
// Quy ước số liệu:
//  - Doanh thu ghi nhận theo NGÀY THANH TOÁN THÀNH CÔNG (payments.status = 'SUCCEEDED'), giờ Việt Nam.
//  - Doanh thu thuần = số tiền đã thu - số tiền đã hoàn (refunded_amount).
//  - Doanh thu từng chuyến: lấy theo THÁNG KHỞI HÀNH của chuyến; booking nhiều chặng được chia cho từng chặng
//    theo tỷ lệ giá vé của chặng đó (booking_segments.subtotal).
const router = require('express').Router();
const ExcelJS = require('exceljs');
const db = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');

const TZ = "'Asia/Ho_Chi_Minh'";
const staffOnly = (req, res, next) => (['ADMIN', 'SUPPORT'].includes(req.user?.role) ? next() : res.status(403).json({ code: 'FORBIDDEN', message: 'Chỉ nhân viên nội bộ mới truy cập được.' }));
const guard = [auth(), staffOnly, requirePermission('revenue.view')];
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });

function parseMonth(v) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const m = /^(\d{4})-(\d{2})$/.exec(String(v || ''));
  const y = m ? +m[1] : now.getFullYear(), mo = m ? +m[2] : now.getMonth() + 1;
  if (mo < 1 || mo > 12 || y < 2000 || y > 2100) throw httpErr(422, 'VALIDATION', 'Tháng không hợp lệ (định dạng YYYY-MM).');
  return { year: y, month: mo, key: `${y}-${String(mo).padStart(2, '0')}`, first: `${y}-${String(mo).padStart(2, '0')}-01` };
}

// ---------------- Doanh thu 12 tháng của một năm ----------------
async function monthly(year) {
  return (await db.query(`
    WITH p AS (
      SELECT date_trunc('month', created_at AT TIME ZONE ${TZ})::date m, amount, refunded_amount, booking_id
      FROM payments WHERE status='SUCCEEDED' AND extract(year FROM created_at AT TIME ZONE ${TZ}) = $1::int)
    SELECT to_char(g,'YYYY-MM') AS "month",
      coalesce(sum(p.amount),0)::float gross, coalesce(sum(p.refunded_amount),0)::float refunded,
      coalesce(sum(p.amount - p.refunded_amount),0)::float net, count(DISTINCT p.booking_id)::int bookings,
      (SELECT count(*)::int FROM passengers x WHERE x.booking_id IN (SELECT booking_id FROM p p2 WHERE p2.m = g::date)) passengers
    FROM generate_series(make_date($1::int,1,1), make_date($1::int,12,1), interval '1 month') g
    LEFT JOIN p ON p.m = g::date GROUP BY g ORDER BY g`, [year])).rows;
}

// ---------------- Tổng hợp 1 tháng ----------------
async function monthSummary(mon) {
  const range = `created_at AT TIME ZONE ${TZ} >= $1::date AND created_at AT TIME ZONE ${TZ} < ($1::date + interval '1 month')`;
  const [tot, prev, daily, byFare, byRoute, byProvider, svc] = await Promise.all([
    db.query(`SELECT coalesce(sum(amount),0)::float gross, coalesce(sum(refunded_amount),0)::float refunded, coalesce(sum(amount-refunded_amount),0)::float net,
        count(DISTINCT booking_id)::int bookings,
        (SELECT count(*)::int FROM passengers x WHERE x.booking_id IN (SELECT booking_id FROM payments WHERE status='SUCCEEDED' AND ${range})) passengers
      FROM payments WHERE status='SUCCEEDED' AND ${range}`, [mon.first]),
    db.query(`SELECT coalesce(sum(amount-refunded_amount),0)::float net, count(DISTINCT booking_id)::int bookings FROM payments
      WHERE status='SUCCEEDED' AND created_at AT TIME ZONE ${TZ} >= ($1::date - interval '1 month') AND created_at AT TIME ZONE ${TZ} < $1::date`, [mon.first]),
    db.query(`SELECT to_char(d,'YYYY-MM-DD') "day", coalesce(sum(p.amount-p.refunded_amount),0)::float net, count(p.payment_id)::int payments
      FROM generate_series($1::date, ($1::date + interval '1 month' - interval '1 day'), interval '1 day') d
      LEFT JOIN payments p ON p.status='SUCCEEDED' AND (p.created_at AT TIME ZONE ${TZ})::date = d::date
      GROUP BY d ORDER BY d`, [mon.first]),
    db.query(`WITH pay AS (SELECT booking_id, sum(amount-refunded_amount) net FROM payments WHERE status='SUCCEEDED' AND ${range} GROUP BY booking_id),
      seg AS (SELECT bs.*, sum(bs.subtotal) OVER (PARTITION BY bs.booking_id) tot, count(*) OVER (PARTITION BY bs.booking_id) cnt FROM booking_segments bs WHERE bs.booking_id IN (SELECT booking_id FROM pay))
      SELECT fc.code, fc.name, round(sum(pay.net * CASE WHEN seg.tot>0 THEN seg.subtotal/seg.tot ELSE 1.0/seg.cnt END))::float net, count(DISTINCT seg.booking_id)::int bookings
      FROM seg JOIN pay ON pay.booking_id=seg.booking_id JOIN fare_classes fc ON fc.fare_class_id=seg.fare_class_id GROUP BY fc.code, fc.name ORDER BY net DESC`, [mon.first]),
    db.query(`WITH pay AS (SELECT booking_id, sum(amount-refunded_amount) net FROM payments WHERE status='SUCCEEDED' AND ${range} GROUP BY booking_id),
      seg AS (SELECT bs.*, sum(bs.subtotal) OVER (PARTITION BY bs.booking_id) tot, count(*) OVER (PARTITION BY bs.booking_id) cnt FROM booking_segments bs WHERE bs.booking_id IN (SELECT booking_id FROM pay))
      SELECT ao.iata_code || '-' || ad.iata_code route, ao.city || ' → ' || ad.city name,
        round(sum(pay.net * CASE WHEN seg.tot>0 THEN seg.subtotal/seg.tot ELSE 1.0/seg.cnt END))::float net, count(DISTINCT seg.booking_id)::int bookings
      FROM seg JOIN pay ON pay.booking_id=seg.booking_id JOIN flights f ON f.flight_id=seg.flight_id
      JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id
      GROUP BY 1,2 ORDER BY net DESC LIMIT 8`, [mon.first]),
    db.query(`SELECT provider, coalesce(sum(amount-refunded_amount),0)::float net, count(*)::int payments FROM payments WHERE status='SUCCEEDED' AND ${range} GROUP BY provider ORDER BY net DESC`, [mon.first]),
    db.query(`SELECT coalesce(sum(bsv.qty*bsv.unit_price),0)::float services FROM booking_services bsv JOIN booking_segments bs ON bs.segment_id=bsv.segment_id
      JOIN bookings b ON b.booking_id=bs.booking_id WHERE b.status='CONFIRMED' AND b.booking_id IN (SELECT booking_id FROM payments WHERE status='SUCCEEDED' AND ${range})`, [mon.first]),
  ]);
  const t = tot.rows[0];
  return {
    month: mon.key, ...t, services: svc.rows[0].services, avgPerBooking: t.bookings ? Math.round(t.net / t.bookings) : 0,
    previous: prev.rows[0], daily: daily.rows, byFare: byFare.rows, byRoute: byRoute.rows, byProvider: byProvider.rows,
  };
}

// ---------------- Doanh thu từng chuyến bay (theo tháng khởi hành) ----------------
async function flightRevenue(mon, { q, sort = 'net', limit = null, offset = 0 } = {}) {
  const params = [mon.first];
  let filter = '';
  if (q) { params.push(`%${String(q).trim().toUpperCase()}%`); filter = `AND (upper(f.flight_no) LIKE $${params.length} OR ao.iata_code || '-' || ad.iata_code LIKE $${params.length} OR upper(ao.city || ' ' || ad.city) LIKE $${params.length})`; }
  const order = { net: 'net DESC', date: 'f.departure_time ASC', pax: 'pax DESC', load: 'load_factor DESC NULLS LAST' }[sort] || 'net DESC';
  const base = `
    WITH pay AS (SELECT booking_id, sum(amount) amt, sum(refunded_amount) ref FROM payments WHERE status='SUCCEEDED' GROUP BY booking_id),
    seg AS (SELECT bs.*, sum(bs.subtotal) OVER (PARTITION BY bs.booking_id) tot, count(*) OVER (PARTITION BY bs.booking_id) cnt FROM booking_segments bs),
    alloc AS (SELECT seg.flight_id, seg.booking_id, seg.segment_id, CASE WHEN seg.tot>0 THEN seg.subtotal/seg.tot ELSE 1.0/seg.cnt END share, pay.amt, pay.ref
              FROM seg JOIN pay ON pay.booking_id=seg.booking_id),
    rows AS (
      SELECT f.flight_id id, f.flight_no "flightNo", f.departure_time "departureTime", f.status,
        ao.iata_code origin, ad.iata_code destination, ao.city "originCity", ad.city "destinationCity", a.registration_no aircraft,
        coalesce(a.seat_capacity, (SELECT count(*)::int FROM seats s WHERE s.aircraft_id=a.aircraft_id)) capacity,
        count(DISTINCT al.booking_id)::int bookings,
        (SELECT count(*)::int FROM booking_segments x JOIN bookings b ON b.booking_id=x.booking_id JOIN passengers p ON p.booking_id=b.booking_id WHERE x.flight_id=f.flight_id AND b.status='CONFIRMED') pax,
        (SELECT coalesce(sum(bsv.qty*bsv.unit_price),0) FROM booking_services bsv JOIN booking_segments x ON x.segment_id=bsv.segment_id JOIN bookings b ON b.booking_id=x.booking_id WHERE x.flight_id=f.flight_id AND b.status='CONFIRMED')::float services,
        round(sum(al.amt*al.share))::float gross, round(sum(al.ref*al.share))::float refunded, round(sum((al.amt-al.ref)*al.share))::float net
      FROM flights f JOIN alloc al ON al.flight_id=f.flight_id
      JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id LEFT JOIN aircraft a ON a.aircraft_id=f.aircraft_id
      WHERE f.departure_time AT TIME ZONE ${TZ} >= $1::date AND f.departure_time AT TIME ZONE ${TZ} < ($1::date + interval '1 month') ${filter}
      GROUP BY f.flight_id, ao.iata_code, ad.iata_code, ao.city, ad.city, a.registration_no, a.seat_capacity, a.aircraft_id)
    SELECT *, CASE WHEN capacity > 0 THEN round(pax * 100.0 / capacity, 1)::float END load_factor FROM rows`;
  const totals = (await db.query(`SELECT count(*)::int flights, coalesce(sum(bookings),0)::int bookings, coalesce(sum(pax),0)::int pax, coalesce(sum(gross),0)::float gross,
      coalesce(sum(refunded),0)::float refunded, coalesce(sum(net),0)::float net, coalesce(sum(services),0)::float services FROM (${base}) t`, params)).rows[0];
  const items = (await db.query(`${base} ORDER BY ${order.replace('f.departure_time', '"departureTime"')} ${limit ? `LIMIT ${limit} OFFSET ${offset}` : ''}`, params)).rows
    .map((r) => ({ ...r, loadFactor: r.load_factor, load_factor: undefined }));
  return { items, totals };
}

router.get('/revenue', guard, async (req, res, next) => {
  try {
    const mon = parseMonth(req.query.month);
    const year = Number(req.query.year) || mon.year;
    const [months, summary, years] = await Promise.all([
      monthly(year), monthSummary(mon),
      db.query(`SELECT DISTINCT extract(year FROM created_at AT TIME ZONE ${TZ})::int y FROM payments WHERE status='SUCCEEDED' ORDER BY 1 DESC`),
    ]);
    const yearList = years.rows.map((r) => r.y);
    if (!yearList.includes(year)) yearList.unshift(year);
    res.json({ year, years: [...new Set(yearList)].sort((a, b) => b - a), months, summary });
  } catch (e) { next(e); }
});

router.get('/revenue/flights', guard, async (req, res, next) => {
  try {
    const mon = parseMonth(req.query.month);
    const size = Math.min(200, Math.max(1, +req.query.size || 20)), page = Math.max(1, +req.query.page || 1);
    const out = await flightRevenue(mon, { q: req.query.q, sort: req.query.sort, limit: size, offset: (page - 1) * size });
    res.json({ month: mon.key, page, size, total: out.totals.flights, totals: out.totals, items: out.items });
  } catch (e) { next(e); }
});

// ---------------- Xuất Excel ----------------
const MONEY = '#,##0" ₫"';
function styleHeader(row) {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4002B' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
  });
  row.height = 30;
}
function styleTotal(row) {
  row.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5D5' } }; c.border = { top: { style: 'thin' } }; });
}
function titleRows(ws, title, sub, cols) {
  ws.mergeCells(1, 1, 1, cols); ws.getCell(1, 1).value = title; ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: 'FFE4002B' } };
  ws.mergeCells(2, 1, 2, cols); ws.getCell(2, 1).value = sub; ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF666666' } };
}

router.get('/revenue/export.xlsx', guard, async (req, res, next) => {
  try {
    const mon = parseMonth(req.query.month);
    const [flights, months, summary] = await Promise.all([flightRevenue(mon, { q: req.query.q, sort: req.query.sort || 'date' }), monthly(mon.year), monthSummary(mon)]);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vietjet Admin Center'; wb.created = new Date();
    const stamp = `Xuất lúc ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} · Nguồn: database vietjet_booking`;
    const label = `${String(mon.month).padStart(2, '0')}/${mon.year}`;

    // Sheet 1: doanh thu từng chuyến
    const ws = wb.addWorksheet(`Chuyến bay ${String(mon.month).padStart(2, '0')}-${mon.year}`, { views: [{ state: 'frozen', ySplit: 4 }] });
    const cols = [
      ['STT', 6], ['Số hiệu', 10], ['Ngày bay', 12], ['Giờ bay', 8], ['Tuyến', 10], ['Điểm đi', 18], ['Điểm đến', 18], ['Máy bay', 11],
      ['Booking', 9], ['Hành khách', 11], ['Sức chứa', 10], ['Tỷ lệ lấp đầy (%)', 13], ['Doanh thu dịch vụ', 17], ['Đã thu', 17], ['Đã hoàn', 15], ['Doanh thu thuần', 18],
    ];
    titleRows(ws, `DOANH THU THEO CHUYẾN BAY - THÁNG ${label}`, `${stamp}${req.query.q ? ` · Lọc: "${req.query.q}"` : ''}`, cols.length);
    ws.columns = cols.map(([, w]) => ({ width: w }));
    styleHeader(ws.getRow(4)); ws.getRow(4).values = cols.map(([h]) => h); styleHeader(ws.getRow(4));
    flights.items.forEach((r, i) => {
      const d = new Date(r.departureTime);
      ws.addRow([i + 1, r.flightNo, d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }), d.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }),
        `${r.origin}-${r.destination}`, r.originCity, r.destinationCity, r.aircraft || '', r.bookings, r.pax, r.capacity || null, r.loadFactor, r.services, r.gross, r.refunded, r.net]);
    });
    const tr = ws.addRow(['', 'TỔNG CỘNG', '', '', '', '', '', '', flights.totals.bookings, flights.totals.pax, '', '', flights.totals.services, flights.totals.gross, flights.totals.refunded, flights.totals.net]);
    styleTotal(tr);
    for (const c of [13, 14, 15, 16]) ws.getColumn(c).numFmt = MONEY;
    ws.getColumn(12).numFmt = '0.0';
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };

    // Sheet 2: theo tháng trong năm
    const wm = wb.addWorksheet(`Theo tháng ${mon.year}`, { views: [{ state: 'frozen', ySplit: 4 }] });
    const mcols = [['Tháng', 12], ['Booking', 10], ['Hành khách', 12], ['Đã thu', 18], ['Đã hoàn', 16], ['Doanh thu thuần', 19]];
    titleRows(wm, `DOANH THU THEO THÁNG - NĂM ${mon.year}`, stamp, mcols.length);
    wm.columns = mcols.map(([, w]) => ({ width: w }));
    wm.getRow(4).values = mcols.map(([h]) => h); styleHeader(wm.getRow(4));
    for (const m of months) wm.addRow([`${m.month.slice(5)}/${m.month.slice(0, 4)}`, m.bookings, m.passengers, m.gross, m.refunded, m.net]);
    const sum = (k) => months.reduce((t, m) => t + m[k], 0);
    styleTotal(wm.addRow(['Cả năm', sum('bookings'), sum('passengers'), sum('gross'), sum('refunded'), sum('net')]));
    for (const c of [4, 5, 6]) wm.getColumn(c).numFmt = MONEY;

    // Sheet 3: tổng hợp tháng
    const wsum = wb.addWorksheet(`Tổng hợp ${String(mon.month).padStart(2, '0')}-${mon.year}`);
    titleRows(wsum, `TỔNG HỢP DOANH THU THÁNG ${label}`, stamp, 3);
    wsum.columns = [{ width: 32 }, { width: 20 }, { width: 14 }];
    const kv = [
      ['Doanh thu thuần', summary.net, MONEY], ['Tổng tiền đã thu', summary.gross, MONEY], ['Đã hoàn tiền', summary.refunded, MONEY],
      ['Doanh thu dịch vụ bổ sung', summary.services, MONEY], ['Số booking đã thanh toán', summary.bookings, '0'], ['Số hành khách', summary.passengers, '0'],
      ['Giá trị trung bình / booking', summary.avgPerBooking, MONEY], ['Doanh thu thuần tháng trước', summary.previous.net, MONEY],
    ];
    kv.forEach(([k, v, f], i) => { const r = wsum.getRow(4 + i); r.getCell(1).value = k; r.getCell(1).font = { bold: true }; r.getCell(2).value = v; r.getCell(2).numFmt = f; });
    let row = 4 + kv.length + 2;
    for (const [title, list, keyName] of [['Theo hạng vé', summary.byFare, 'name'], ['Theo tuyến bay (top 8)', summary.byRoute, 'name'], ['Theo phương thức thanh toán', summary.byProvider, 'provider']]) {
      wsum.getRow(row).values = [title, 'Doanh thu thuần', 'Số booking/GD']; styleHeader(wsum.getRow(row)); row++;
      for (const x of list) { const r = wsum.getRow(row++); r.values = [x[keyName], x.net, x.bookings ?? x.payments]; r.getCell(2).numFmt = MONEY; }
      row++;
    }

    const filename = `doanh-thu-${mon.key}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

module.exports = router;
