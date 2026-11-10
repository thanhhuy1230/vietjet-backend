#!/usr/bin/env node
// Đưa toàn bộ dự án Vietjet ra Internet bằng NGROK với MỘT đường link duy nhất:
//
//   https://xxxx.ngrok-free.app/          -> web khách hàng (bản build của vietjet-customer)
//   https://xxxx.ngrok-free.app/admin/    -> trang Admin
//   https://xxxx.ngrok-free.app/api/v1    -> API (VNPAY IPN: /api/v1/payments/vnpay/ipn)
//
// Cả 3 cùng đi qua backend (cổng 3000) nên chỉ cần 1 tunnel - đúng giới hạn gói ngrok miễn phí,
// không lo CORS, VNPAY chuyển khách về đúng địa chỉ công khai.
//
// Cách dùng (chạy từ thư mục chứa vietjet-backend / vietjet-admin / vietjet-customer):
//   node tools/share.js              build web + chạy backend + mở ngrok
//   node tools/share.js --no-build   dùng lại bản build web lần trước (nhanh hơn)
//   node tools/share.js --mobile     như trên + mở Expo Go qua tunnel (quét QR từ bất kỳ mạng nào)
//
// Yêu cầu: Node 18+, đã cài ngrok và đã chạy `ngrok config add-authtoken <token>` một lần.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Đặt 3 thư mục vietjet-backend, vietjet-admin, vietjet-customer cạnh nhau (giải nén 3 file zip vào cùng 1 thư mục).
const ROOT = process.env.VIETJET_ROOT ? path.resolve(process.env.VIETJET_ROOT) : path.resolve(__dirname, '..', '..');
const BACKEND_ROOT = path.join(ROOT, 'vietjet-backend');
const BACKEND = path.join(BACKEND_ROOT, 'backend');
const ADMIN = path.join(ROOT, 'vietjet-admin');
const CUSTOMER = path.join(ROOT, 'vietjet-customer');
const PORT = Number(process.env.PORT || 3000);
const NGROK_API = process.env.NGROK_API || 'http://127.0.0.1:4040';
const isWin = process.platform === 'win32';

const argv = new Set(process.argv.slice(2));
const MOBILE = argv.has('--mobile');
const NO_BUILD = argv.has('--no-build');

const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* đã tắt */ } }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => { console.log('\nĐang tắt...'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));
function fail(msg, code = 1) { console.error('\n✖ ' + msg + '\n'); shutdown(code); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, timeoutMs = 1500) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return r.json();
}
async function isUp(url) { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } }

// Tìm tunnel https đang trỏ vào cổng backend (qua API cục bộ của ngrok, cổng 4040)
async function findTunnel() {
  try {
    const { tunnels = [] } = await getJson(`${NGROK_API}/api/tunnels`);
    const t = tunnels.find(x => String(x.public_url).startsWith('https://') && new RegExp(`:${PORT}\\b|//localhost:${PORT}|//127\\.0\\.0\\.1:${PORT}`).test(x.config?.addr || ''));
    return t ? t.public_url.replace(/\/+$/, '') : null;
  } catch { return null; }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    children.push(p);
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} thoát với mã ${code}`))));
  });
}

// Chạy Expo CLI trực tiếp bằng node (tránh phụ thuộc .bin/npx, chạy được trên Windows lẫn Linux)
function expoCmd(extraArgs) {
  const cli = path.join(CUSTOMER, 'node_modules', 'expo', 'bin', 'cli');
  if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli, ...extraArgs], shell: false };
  return { cmd: 'npx', args: ['expo', ...extraArgs], shell: isWin };
}

async function main() {
  for (const d of [BACKEND, ADMIN, CUSTOMER]) {
    if (!fs.existsSync(d)) return fail(`Không thấy thư mục ${d}\nHãy đặt thư mục "tools" cùng cấp với vietjet-backend, vietjet-admin, vietjet-customer.`);
  }

  // 1) Cổng backend phải trống (nếu backend đã chạy sẵn thì thiếu cấu hình ngrok -> bắt tắt đi chạy lại)
  if (await isUp(`http://127.0.0.1:${PORT}/api/v1/health`)) {
    return fail(`Cổng ${PORT} đang có backend chạy sẵn.\nHãy tắt nó (Ctrl+C ở cửa sổ backend) rồi chạy lại - script này sẽ tự khởi động backend với cấu hình ngrok.`);
  }

  // 2) ngrok
  let url = await findTunnel();
  if (url) {
    console.log(`• Dùng lại tunnel ngrok đang chạy: ${url}`);
  } else {
    const probe = spawnSync('ngrok', ['version'], { shell: isWin, encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      return fail([
        'Không tìm thấy ngrok. Cài đặt:',
        '  1) Tạo tài khoản miễn phí: https://dashboard.ngrok.com/signup',
        '  2) Windows: winget install ngrok.ngrok   (hoặc tải ngrok.exe tại https://ngrok.com/download rồi thêm vào PATH)',
        '  3) Lấy authtoken tại https://dashboard.ngrok.com/get-started/your-authtoken rồi chạy:',
        '       ngrok config add-authtoken <TOKEN_CUA_BAN>',
        'Sau đó chạy lại lệnh này.',
      ].join('\n'));
    }
    console.log(`• Mở ngrok -> cổng ${PORT} ...`);
    const ng = spawn('ngrok', ['http', String(PORT), '--log=stdout'], { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin });
    children.push(ng);
    const tail = [];
    const keep = d => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 25) tail.shift(); } };
    ng.stdout.on('data', keep); ng.stderr.on('data', keep);
    let exited = false;
    ng.on('exit', () => { exited = true; });
    for (let i = 0; i < 60 && !url; i++) {
      await sleep(500);
      url = await findTunnel();
      if (exited && !url) return fail('ngrok thoát sớm:\n' + tail.slice(-8).join('\n') + '\n\nThường do chưa có authtoken (ngrok config add-authtoken ...) hoặc đang có phiên ngrok khác chạy trên tài khoản.');
    }
    if (!url) return fail('Chờ 30 giây mà ngrok chưa sẵn sàng. Log ngrok:\n' + tail.slice(-8).join('\n'));
  }

  // 3) Build web khách hàng (đường dẫn API tương đối vì web do backend phục vụ cùng origin)
  const webDir = path.join(BACKEND_ROOT, 'web');
  const adminDir = path.join(BACKEND_ROOT, 'admin');
  if (NO_BUILD && fs.existsSync(path.join(webDir, 'index.html'))) {
    console.log('• Bỏ qua build web (--no-build), dùng bản trong vietjet-backend/web');
  } else {
    console.log('• Build web khách hàng (lần đầu có thể mất 1-3 phút) ...');
    const { cmd, args, shell } = expoCmd(['export', '-p', 'web', '--clear']);
    try {
      await run(cmd, args, { cwd: CUSTOMER, shell, env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_API_BASE_URL: '/api/v1' } });
    } catch (e) { return fail('Build web thất bại: ' + e.message + '\nHãy chạy `npm install` trong vietjet-customer rồi thử lại.'); }
    fs.rmSync(webDir, { recursive: true, force: true });
    fs.cpSync(path.join(CUSTOMER, 'dist'), webDir, { recursive: true });
  }

  // 4) Chép trang admin vào vietjet-backend/admin (backend phục vụ tại /admin/)
  fs.rmSync(adminDir, { recursive: true, force: true });
  fs.mkdirSync(adminDir, { recursive: true });
  for (const f of fs.readdirSync(ADMIN)) {
    const src = path.join(ADMIN, f);
    if (fs.statSync(src).isFile() && /\.(html|js|css|png|jpg|jpeg|svg|ico|webp)$/i.test(f)) fs.copyFileSync(src, path.join(adminDir, f));
  }

  // 5) Chạy backend với địa chỉ công khai (WEB_URL: nơi VNPAY chuyển khách về; PUBLIC_BASE_URL: dựng Return URL)
  console.log('• Khởi động backend ...');
  const be = spawn(process.execPath, ['src/server.js'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, WEB_URL: url, PUBLIC_BASE_URL: url } });
  children.push(be);
  be.on('exit', code => { if (!shuttingDown) fail(`Backend đã dừng (mã ${code}). Xem lỗi phía trên (thường là chưa bật PostgreSQL hoặc sai DATABASE_URL trong backend/.env).`, code || 1); });
  for (let i = 0; i < 40; i++) { if (await isUp(`http://127.0.0.1:${PORT}/api/v1/health`)) break; await sleep(500); }

  let dbOk = false;
  try { dbOk = (await getJson(`http://127.0.0.1:${PORT}/api/v1/health`, 3000)).database === 'connected'; } catch { /* in cảnh báo bên dưới */ }

  const line = '─'.repeat(70);
  console.log(`\n${line}\n  ĐÃ SẴN SÀNG - gửi các link này cho người test\n${line}`);
  console.log(`  Web khách hàng : ${url}/`);
  console.log(`  Trang Admin    : ${url}/admin/`);
  console.log(`  Kiểm tra API   : ${url}/api/v1/health`);
  console.log(`\n  VNPAY (đăng ký/gửi cho VNPAY):`);
  console.log(`    IPN URL      : ${url}/api/v1/payments/vnpay/ipn`);
  console.log(`    Return URL   : ${url}/payment/vnpay/callback   (backend tự dùng, không cần khai báo)`);
  console.log(`\n  Lần đầu mở link, ngrok hiện trang cảnh báo -> bấm "Visit Site".`);
  console.log(`  Bản build APK: sửa vietjet-customer/eas.json (EXPO_PUBLIC_API_BASE_URL = ${url}/api/v1)`);
  if (!dbOk) console.log('\n  ⚠ Backend chưa nối được PostgreSQL (database != connected): kiểm tra DATABASE_URL trong backend/.env.');
  console.log(`${line}\n  Nhấn Ctrl+C để tắt tất cả.\n`);

  // 6) (tuỳ chọn) Expo Go qua tunnel: điện thoại ở mạng nào cũng quét QR được, app gọi API qua ngrok
  if (MOBILE) {
    console.log('• Mở Expo Go qua tunnel (nếu được hỏi cài @expo/ngrok thì chọn Y) ...');
    const { cmd, args, shell } = expoCmd(['start', '--tunnel']);
    const ex = spawn(cmd, args, { cwd: CUSTOMER, shell, stdio: 'inherit', env: { ...process.env, EXPO_PUBLIC_API_BASE_URL: `${url}/api/v1` } });
    children.push(ex);
    ex.on('exit', () => { if (!shuttingDown) shutdown(0); });
  }
}

main().catch(e => fail(e.stack || String(e)));
