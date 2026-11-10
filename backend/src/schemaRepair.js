// Đồng bộ cấu trúc database với database/schema.sql + upgrade.sql mà KHÔNG xóa dữ liệu.
// Dùng khi database được tạo từ script cũ / tạo tay trong pgAdmin: bảng có rồi nhưng thiếu cột
// (vd. "column u.created_at does not exist", "column sent_at does not exist").
//  - Bảng chưa có  -> tạo mới theo đúng định nghĩa trong file .sql
//  - Bảng đã có    -> thêm các cột còn thiếu (giữ nguyên dữ liệu; cột NOT NULL được thêm kèm DEFAULT)
//  - Câu lệnh khác (index, ALTER, DO $$...$$, INSERT) -> chạy từng câu, câu nào lỗi thì ghi log rồi chạy tiếp
const fs = require('fs');

// Tách file SQL thành từng câu lệnh (bỏ qua ; nằm trong chuỗi '...', "..." hoặc khối $$...$$)
function splitStatements(sql) {
  const out = []; let cur = ''; let i = 0; let q = null; let dollar = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (!q && !dollar && ch === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl; continue; }
    if (!q && !dollar && ch === '$') { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i)); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (dollar && sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; }
    if (!dollar && (ch === "'" || ch === '"')) { if (!q) q = ch; else if (q === ch) q = null; }
    if (!q && !dollar && ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Tách theo dấu phẩy ở cấp ngoài cùng (không tách bên trong ngoặc / chuỗi)
function splitTopLevel(body) {
  const parts = []; let depth = 0; let cur = ''; let q = null;
  for (const ch of body) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseCreateTable(stmt) {
  const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)\s*\(/i.exec(stmt);
  if (!m) return null;
  const start = m[0].length; let depth = 1; let end = start;
  for (; end < stmt.length && depth > 0; end++) { if (stmt[end] === '(') depth++; else if (stmt[end] === ')') depth--; }
  const body = stmt.slice(start, end - 1);
  const columns = [];
  for (const part of splitTopLevel(body)) {
    if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT|EXCLUDE)\b/i.test(part)) continue;
    const cm = /^("?\w+"?)\s+([\s\S]+)$/.exec(part);
    if (cm) columns.push({ name: cm[1].replace(/"/g, ''), def: cm[2] });
  }
  return { table: m[1].replace(/"/g, ''), columns, createSql: stmt.replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ') };
}

const KW = /\s+(PRIMARY\s+KEY|NOT\s+NULL|NULL|DEFAULT|REFERENCES|UNIQUE|CHECK|GENERATED|CONSTRAINT|COLLATE)\b/i;
// Lấy phần tiếp theo cho tới từ khóa kế tiếp ở cấp ngoài cùng ngoặc
function takeUntilKeyword(s) {
  let depth = 0; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'") { q = ch; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch)) { const rest = s.slice(i); const k = KW.exec(rest); if (k && k.index === 0) return [s.slice(0, i).trim(), rest.trim()]; }
  }
  return [s.trim(), ''];
}
function parseColumnDef(def) {
  const [type, restStart] = takeUntilKeyword(def.trim());
  let rest = restStart; const out = { type, default: null, notNull: false, primaryKey: false, references: null, unique: false };
  while (rest) {
    let m;
    if ((m = /^PRIMARY\s+KEY\b/i.exec(rest))) { out.primaryKey = true; rest = rest.slice(m[0].length).trim(); }
    else if ((m = /^NOT\s+NULL\b/i.exec(rest))) { out.notNull = true; rest = rest.slice(m[0].length).trim(); }
    else if ((m = /^NULL\b/i.exec(rest))) { rest = rest.slice(m[0].length).trim(); }
    else if ((m = /^UNIQUE\b/i.exec(rest))) { out.unique = true; rest = rest.slice(m[0].length).trim(); }
    else if ((m = /^DEFAULT\b/i.exec(rest))) { const [v, r] = takeUntilKeyword(rest.slice(m[0].length).trim()); out.default = v; rest = r; }
    else if ((m = /^REFERENCES\b/i.exec(rest))) { const [v, r] = takeUntilKeyword(rest.slice(m[0].length).trim()); out.references = v; rest = r; }
    else if ((m = /^(CHECK|GENERATED|CONSTRAINT|COLLATE)\b/i.exec(rest))) { const [, r] = takeUntilKeyword(rest.slice(m[0].length).trim()); rest = r; }
    else break;
  }
  return out;
}

async function tableExists(db, t) { return !!(await db.query('SELECT to_regclass($1) t', [`public.${t}`])).rows[0].t; }
async function columnsOf(db, t) { return new Set((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [t])).rows.map((r) => r.column_name)); }

async function addColumn(db, table, col, log) {
  const c = parseColumnDef(col.def);
  const rows = (await db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n;
  let def = c.default;
  if (c.primaryKey && !def && /uuid/i.test(c.type)) def = 'gen_random_uuid()';
  // Cột NOT NULL không có DEFAULT trên bảng đang có dữ liệu -> thêm dạng cho phép NULL (không thể tự bịa giá trị)
  const notNull = c.notNull || c.primaryKey ? (def || rows === 0) : false;
  const attempts = [
    [c.type, def && `DEFAULT ${def}`, notNull && 'NOT NULL', c.unique && 'UNIQUE', c.references && `REFERENCES ${c.references}`],
    [c.type, def && `DEFAULT ${def}`, notNull && 'NOT NULL'],
    [c.type, def && `DEFAULT ${def}`],
  ];
  for (const parts of attempts) {
    const sql = `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col.name}" ${parts.filter(Boolean).join(' ')}`;
    try { await db.query(sql); log.push(`+ cột ${table}.${col.name} (${c.type})`); return; } catch (e) { /* thử dạng đơn giản hơn */ }
  }
  log.push(`! không thêm được cột ${table}.${col.name} - hãy kiểm tra bằng tay`);
}

async function applyFile(db, file, log) {
  for (const stmt of splitStatements(fs.readFileSync(file, 'utf8'))) {
    const ct = parseCreateTable(stmt);
    if (ct) {
      if (!(await tableExists(db, ct.table))) {
        try { await db.query(ct.createSql); log.push(`+ bảng ${ct.table}`); }
        catch (e) { log.push(`! không tạo được bảng ${ct.table}: ${e.message}`); }
        continue;
      }
      const have = await columnsOf(db, ct.table);
      for (const col of ct.columns) if (!have.has(col.name)) await addColumn(db, ct.table, col, log);
      continue;
    }
    const sql = stmt.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, (m0, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `);
    try { await db.query(sql); }
    catch (e) {
      // lỗi "đã tồn tại" là bình thường khi chạy lại; lỗi khác thì ghi lại để biết
      if (!/already exists|đã tồn tại/i.test(e.message)) log.push(`! ${e.message} :: ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
}

module.exports = { applyFile, splitStatements, parseCreateTable, parseColumnDef };
