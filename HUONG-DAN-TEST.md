# Hướng dẫn test Vietjet (SMS OTP + VNPAY + LAN + ngrok)

IPv4 máy chạy backend: **192.168.1.5** (nếu đổi mạng, IP này có thể đổi – xem mục 6).

## 1. Đã cấu hình gì
| Việc | Ở đâu |
|---|---|
| Khóa eSMS + SpeedSMS, `OTP_DELIVERY=sms`, thử SpeedSMS trước rồi tới eSMS | `vietjet-backend/backend/.env` |
| VNPAY sandbox: `VNPAY_BRAND_CODE=QA91LHJY` (vnp_TmnCode), `VNPAY_HASH_SECRET`, URL sandbox | `backend/.env`, `docker-compose.yml` |
| IP 192.168.1.5 trong CORS / `WEB_URL` | `backend/.env`, `docker-compose.yml` |
| App mobile + web gọi API `http://192.168.1.5:3000/api/v1` | `vietjet-customer/app.json` |
| Admin tự nhận địa chỉ API (LAN hoặc cùng domain khi qua ngrok) | `vietjet-admin/config.js` |
| Gửi SMS dự phòng nhiều nhà mạng | `backend/src/utils/otpProvider.js` |
| Lệnh gửi thử SMS | `npm run test:sms -- 0384837357` |
| ngrok 1 link cho web + admin + API | `vietjet-backend/tools/share.js`, `vietjet-backend/start-ngrok*.bat` |
| Build APK | `vietjet-customer/eas.json` |

## 2. Gửi thử SMS trước (nên làm đầu tiên)
```
cd vietjet-backend\backend
npm run test:sms -- 0384837357
```
Mỗi tin trừ tiền (SpeedSMS còn 2.000đ). Nếu lỗi: kiểm tra số dư/khóa; đổi `SPEEDSMS_SMS_TYPE` / `ESMS_SMS_TYPE` trong `.env`.
Cần xem OTP ngay trên màn hình khi SMS chưa chạy: đặt `OTP_DELIVERY=backend` rồi khởi động lại backend.

## 3. Test trên mạng LAN (web + mobile)
1. Bật PostgreSQL, rồi chạy lần lượt `vietjet-backend/run-backend.bat`, `vietjet-admin/run-admin.bat`, `vietjet-customer/run-customer.bat`.
2. Máy tính: web `http://192.168.1.5:8081`, admin `http://192.168.1.5:8090`.
3. Điện thoại (cùng Wi-Fi): mở Expo Go, quét QR ở cửa sổ customer.
4. Lần đầu Windows hỏi tường lửa cho Node.js → chọn **Allow** (mạng Private). Nếu điện thoại không vào được, mở cổng 3000, 8081, 8090.

## 4. Test qua ngrok (mọi mạng, có link để gửi người khác)
1. Cài ngrok, chạy một lần: `ngrok config add-authtoken <TOKEN>`.
2. Tắt backend đang chạy, rồi chạy `start-ngrok.bat` (thêm `--no-build` nếu web đã build).
3. Script in ra link dạng `https://xxxx.ngrok-free.app/` (web), `/admin/`, và IPN URL. Mở link lần đầu bấm **Visit Site**.
4. Mobile qua ngrok: chạy `start-ngrok-mobile.bat` rồi quét QR bằng Expo Go (có thể hỏi cài `@expo/ngrok` → chọn Y).
5. File APK để tải về: sửa `vietjet-customer/eas.json` (điền link ngrok), rồi `npx eas-cli build -p android --profile preview` (cần tài khoản Expo; bản này mình chưa chạy thử). APK nên dùng link ngrok https vì Android chặn http thường.
Gói ngrok free có 1 domain cố định nên link không đổi giữa các lần chạy.

## 5. VNPAY sandbox
- IPN URL gửi cho VNPAY: `https://<domain-ngrok>/api/v1/payments/vnpay/ipn`
- Không có IPN thì vé vẫn được xác nhận khi khách quay về Return URL (backend xử lý cả hai).
- Thẻ test thường dùng của sandbox VNPAY: ngân hàng NCB, số thẻ `9704198526191432198`, tên `NGUYEN VAN A`, ngày phát hành `07/15`, OTP `123456` (nếu không được, dùng dữ liệu test trong tài liệu VNPAY gửi bạn).
- Nếu thanh toán xong mà vé vẫn chờ: xem log backend có dòng `[VNPAY...]` không.

## 6. Khi đổi IP
Đổi `192.168.1.5` trong: `backend/.env` (CORS_ORIGINS, WEB_URL), `vietjet-customer/app.json`, `run-customer.bat`, `vietjet-admin/config.js` (LAN_IP).

## 7. Bảo mật
- Khóa SMS và secret VNPAY đang nằm trong `backend/.env` (đã nằm trong `.gitignore`, **đừng đẩy lên GitHub**). Ảnh chụp có khóa đã gửi trong chat → sau khi demo xong nên bấm "Tạo khóa mới" ở eSMS và đổi token SpeedSMS.
- Qua ngrok, ai có link đều vào được và đăng nhập admin bằng `admin@vietjet.local / Vietjet@123` → **đổi mật khẩu admin trước khi chia sẻ link**.

## 8. Đăng nhập / Đăng ký khách hàng (đã tách riêng, đều có OTP)
**Đăng nhập** (màn Đăng nhập): nhập Email + SĐT → backend kiểm tra tài khoản → có thì gửi OTP, chưa có thì báo "Tài khoản chưa tồn tại" và chuyển sang Đăng ký → nhập OTP → vào app.
**Đăng ký** (màn Đăng ký): nhập Họ, Tên, Ngày sinh, Email, SĐT → backend kiểm tra trùng rồi gửi OTP → nhập OTP đúng mới **tạo tài khoản** → quay về Đăng nhập.
| API | Việc |
|---|---|
| `POST /api/v1/auth/login/identify` `{email, phone}` | 200 gửi OTP · 404 `ACCOUNT_NOT_FOUND` · 409 `IDENTITY_MISMATCH` |
| `POST /api/v1/auth/login/verify` `{email, phone, otp}` | 200 trả token |
| `POST /api/v1/auth/signup/request` `{familyName, givenName, email, phone, dateOfBirth}` | 200 gửi OTP · 409 `PHONE_ALREADY_REGISTERED` / `EMAIL_ALREADY_REGISTERED` / `IDENTITY_NOT_AVAILABLE` |
| `POST /api/v1/auth/signup/verify` `{...như trên, otp}` | 201 tạo tài khoản |
Đã bỏ hẳn bước "Hoàn thiện đăng ký" (`/auth/otp/request`, `/auth/otp/verify`, `/auth/register-phone`).

**Bắt buộc sau khi cập nhật:** chạy `npm run migrate` trong `vietjet-backend\backend` (thêm cột `phone_otps.purpose`).

**Tài khoản "mồ côi"** (có trong bảng users nhưng không có role CUSTOMER, như số 0384837357): hệ thống sẽ KHÔNG đăng nhập/đăng ký đè lên. Mở `vietjet-backend\database\fix-orphan-users.sql` trong pgAdmin, chạy phần 1 để xem, rồi chọn 2a (gán role) hoặc 2c (xóa).

**Chạy test tự động** (không gửi SMS thật): chạy backend bằng
`$env:OTP_DELIVERY="backend"; $env:OTP_RATE_LIMIT_PER_HOUR="1000"; npm start`, rồi ở cửa sổ khác `npm test`.
Khi chạy thật, đặt lại `OTP_DELIVERY=sms` và bỏ `OTP_RATE_LIMIT_PER_HOUR` (mặc định 20 lần/giờ/IP cho các bước gửi OTP).

## 9. Đồng bộ dữ liệu thật (Admin ↔ App khách ↔ Backend)
Sau khi cập nhật code, chạy **một lần**: `cd vietjet-backend\backend` → `npm install` → `npm run migrate` (an toàn khi chạy lại, không mất dữ liệu).
Nếu vừa nạp thêm chuyến bay bằng `npm run seed:flights` thì chạy `npm run migrate` thêm một lần để danh sách tuyến bay được tạo đủ.

Không còn dữ liệu mẫu gắn cứng ở admin hay app. Kiểm tra nhanh tính đồng bộ:
| Làm ở Admin Center | Thấy ở app khách hàng |
|---|---|
| Sân bay → Thêm / tạm ngưng | Ô Điểm đi / Điểm đến |
| Dịch vụ bổ sung → Thêm / đổi giá | Bước Dịch vụ + tổng tiền |
| Khuyến mãi → Thêm mã | Trang chủ, màn Ưu đãi, ô nhập mã ở Thanh toán |
| Thông báo → Soạn thông báo | Tab Thông báo |
| Hội thoại → Trả lời | Nút chat 💬 (tự cập nhật 4 giây/lần) |
| Đánh giá → Duyệt + phản hồi | Màn Đánh giá + thông báo |
| Khách hàng → Khóa | Khách bị đăng xuất, không đăng nhập được |

Ngược lại: khách đặt vé / chat / đánh giá → hiện ngay ở Tổng quan, Khách hàng, Hội thoại, Đánh giá của admin.
Check-in trực tuyến mở trước giờ bay 24 giờ, đóng trước 60 phút (đổi bằng `CHECKIN_OPEN_HOURS`, `CHECKIN_CLOSE_MINUTES` trong `.env`).
