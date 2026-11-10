# Vietjet - Backend (API + PostgreSQL)

> Hệ thống gồm **3 dự án độc lập**: `vietjet-backend` (dự án này), `vietjet-admin` (web quản trị), `vietjet-customer`
> (app khách hàng Expo SDK 58). Mỗi dự án cài đặt và chạy riêng; admin và app khách chỉ cần biết địa chỉ API (cổng 3000).
> Thứ tự chạy: **PostgreSQL → backend → admin / customer**.

REST API Node.js/Express, lưu toàn bộ dữ liệu vào PostgreSQL 17 trên máy bạn:
**database `vietjet_booking`** (cái đang thấy trong pgAdmin).

```
backend/   # mã nguồn API (+ file .env cấu hình kết nối)
database/  # schema.sql (tạo bảng), seed.sql (dữ liệu nền), seed-demo.sql (mẫu, tuỳ chọn)
docs/      # API.md, DEPLOYMENT.md
```

## 1. Kết nối database
Mở `backend/.env`, sửa mật khẩu PostgreSQL của bạn:
```
DATABASE_URL=postgresql://postgres:MAT_KHAU_POSTGRES@localhost:5432/vietjet_booking
```
(đổi `postgres` nếu bạn dùng user khác, đổi `5432` nếu PostgreSQL chạy cổng khác)

## 2. Chạy
```bash
cd backend
npm install
npm run migrate     # tạo bảng trong vietjet_booking + áp dụng nâng cấp schema (an toàn khi chạy lại, không mất dữ liệu)
npm run seed        # nạp dữ liệu nền: vai trò, quyền, sân bay, hạng vé, dịch vụ, 1 tài khoản admin
npm start           # API chạy ở http://localhost:3000
```
Kiểm tra: http://localhost:3000/api/v1/health phải trả `"database":"connected"`.

Từ giờ mọi thứ khách đặt vé (tài khoản, đặt chỗ, thanh toán, đánh giá...) được ghi thẳng vào các bảng trong pgAdmin.

## Dữ liệu
- `npm run seed` KHÔNG tạo chuyến bay, khách hàng hay khuyến mãi mẫu. Chỉ có:
  tài khoản admin `admin@vietjet.local` / `Vietjet@123` (đổi mật khẩu sau khi đăng nhập), 4 sân bay, 1 máy bay VN-A678, 3 hạng vé, 4 dịch vụ.
- Khách hàng tự đăng ký trong app bằng số điện thoại + OTP (khi `OTP_DELIVERY=backend`, mã OTP hiện ngay trên màn hình và trong log backend).
- Chưa có chuyến bay thì tìm vé sẽ trống: vào Admin Center → Quản lý chuyến bay để tạo (lưu thẳng vào bảng `flights`, `flight_fares`, `flight_inventory`). Muốn nạp thử chuyến bay + khuyến mãi mẫu: `npm run seed:demo`.

## Docker (tuỳ chọn)
`docker compose up --build` chạy API trong container và nối tới PostgreSQL trên máy bạn qua `host.docker.internal`. Đặt biến `DATABASE_URL` cho đúng mật khẩu.

## Lưu ý
- Backend không phục vụ giao diện web/admin; chạy riêng `vietjet-customer` (cổng 8081) và `vietjet-admin` (cổng 8090).
- Chia sẻ qua ngrok (1 link cho web + admin + API): giải nén 3 dự án **cạnh nhau trong cùng 1 thư mục**, cài `npm install` cho backend và customer, rồi chạy `start-ngrok.bat` (hoặc `node tools/share.js`). Có thể chỉ định thư mục chứa 3 dự án bằng biến `VIETJET_ROOT`.
- `WEB_URL`: địa chỉ web khách hàng, VNPAY thanh toán xong chuyển khách về đây.
- Đổi `JWT_SECRET` và các secret khác trước khi đưa lên Internet.

## Sửa lỗi "column ... does not exist" & tạo dữ liệu mẫu
Nếu database được tạo từ script cũ / tạo tay trong pgAdmin, các trang admin có thể báo lỗi kiểu
`column u.created_at does not exist`, `column sent_at does not exist`. Chạy:
```bash
npm install          # cài thêm thư viện exceljs (xuất Excel)
npm run migrate      # so sánh database với schema.sql + upgrade.sql: tự thêm BẢNG và CỘT còn thiếu, không xóa dữ liệu
npm run seed         # dữ liệu nền (vai trò, quyền, sân bay, hạng vé, dịch vụ, tài khoản admin) - bỏ qua nếu đã có
npm run seed:sample  # dữ liệu mẫu cho các trang admin
```
`npm run migrate` in ra danh sách bảng/cột vừa thêm. `npm run seed:sample` tạo: 18 khách hàng (`*@demo.vietjet.vn`),
2 nhân viên (`cskh@vietjet.local`, `dieuhanh@vietjet.local` / `Vietjet@123`), các chuyến bay đã bay trong 6 tháng gần nhất
kèm booking, thanh toán, vé, hoàn tiền (để trang Doanh thu có số liệu), đánh giá, hội thoại và thông báo.
Chỉ tạo 1 lần; muốn xóa và tạo lại: `npm run seed:sample -- --reset`.

## Doanh thu & xuất Excel
- `GET /admin/revenue?month=YYYY-MM&year=YYYY` - doanh thu 12 tháng của năm + tổng hợp tháng (theo ngày, hạng vé, tuyến, phương thức thanh toán)
- `GET /admin/revenue/flights?month=YYYY-MM&q=&sort=net|date|pax|load&page=` - doanh thu từng chuyến (theo tháng khởi hành)
- `GET /admin/revenue/export.xlsx?month=YYYY-MM` - file Excel 3 sheet: theo chuyến bay, theo tháng trong năm, tổng hợp tháng
- Quyền `revenue.view` (Quản trị viên luôn có; cấp thêm cho nhân viên ở trang Nhân viên → Phân quyền → nhóm "Báo cáo").

## Đồng bộ Admin ↔ Khách hàng ↔ Backend
Sau khi cập nhật code **bắt buộc chạy `npm run migrate`** (an toàn khi chạy lại, không mất dữ liệu). Migration thêm:
bảng `routes`, các cột quản lý máy bay (`seat_capacity`, `manufacture_year`, `flight_hours`, `next_maintenance`), `airports.country`,
`fare_classes.status/description`, `notifications.campaign_id/created_by`, 4 quyền mới (`routes.manage`, `aircraft.manage`, `fares.manage`,
`customers.manage`) và phát hành vé điện tử cho các booking đã xác nhận trước đây. Nếu bạn vừa nạp thêm chuyến bay, chạy `npm run migrate`
lần nữa để danh sách tuyến bay được tạo đủ.

Mọi dữ liệu hai giao diện dùng đều nằm trong PostgreSQL:
- **App khách hàng**: sân bay/tuyến (`/catalog/airports`, `/catalog/routes`), dịch vụ (`/catalog/services`), khuyến mãi (`/promotions/active`,
  `/promotions/validate`), đặt vé, thông báo, chat với nhân viên (`/chat`), đánh giá chuyến đã bay (`/reviews`), check-in trực tuyến (`/checkin`).
- **Admin Center**: `/admin/dashboard`, `/admin/flights` (phân trang), `/admin/routes`, `/admin/airports`, `/admin/aircraft`, `/admin/fares`,
  `/admin/services`, `/admin/promotions`, `/admin/customers`, `/admin/chats`, `/admin/reviews`, `/admin/notifications`, `/admin/users`.
- **Tiền vé tính ở server**: giá vé × số khách + giá ghế + dịch vụ bổ sung − khuyến mãi (kiểm tra đơn tối thiểu, tổng lượt, số lần mỗi khách).
  Thanh toán xong: booking `CONFIRMED`, phát hành `tickets`, trừ số chỗ còn bán; hủy vé đã thanh toán thì trả lại chỗ.
- Check-in mở trước giờ bay `CHECKIN_OPEN_HOURS` giờ (mặc định 24), đóng trước `CHECKIN_CLOSE_MINUTES` phút (mặc định 60).


## SkyJoy - khách hàng thân thiết
Sau khi cập nhật code chạy `npm run migrate` (thêm bảng `loyalty_accounts`, `loyalty_transactions`, cột `bookings.points_redeemed`,
`bookings.points_discount`). Không cần seed: điểm của các booking đã xác nhận trước đây được tự tạo khi khách mở SkyJoy lần đầu.

Quy tắc (chỉnh trong `.env`, xem `.env.example`; mặc định như dưới) - là quy tắc của đồ án, mô phỏng SkyJoy, không phải điều khoản chính thức:
- Tích điểm: 1 điểm / 10.000 ₫ thực trả × hệ số hạng. Điểm "Chờ cộng" khi thanh toán, chuyển "Khả dụng" khi chuyến cuối hạ cánh.
- Hạng theo điểm tích lũy 12 tháng: Thành viên 0 (x1) · Bạc 1.000 (x1,1) · Vàng 3.000 (x1,25) · Kim cương 6.000 (x1,5).
- Dùng điểm: 1 điểm = 100 ₫, tối thiểu 100 điểm, tối đa 50% giá trị đơn sau khuyến mãi. Điểm bị giữ khi tạo booking, trừ hẳn khi
  thanh toán, trả lại khi booking hết hạn giữ chỗ / bị hủy trước khi thanh toán, hoàn lại khi hủy vé đã thanh toán.
- Chưa có hết hạn điểm và chưa có trang quản trị điểm.

API: `GET /loyalty/me`, `GET /loyalty/transactions?page=`; `POST /bookings` nhận thêm `redeemPoints` (tùy chọn).
