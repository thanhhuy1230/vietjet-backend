# API contract đề xuất

Base URL: `/api/v1`. Mọi thao tác quản trị cần JWT và quyền phù hợp.

## UC-00 Xác thực (Auth) — đã implement, đã test thật

Đăng nhập được **tách làm 2 cổng riêng biệt**, cùng bảng `users` nhưng lọc theo role:
- Khách hàng: `POST /auth/login` — chỉ tài khoản có role `CUSTOMER`.
- Nội bộ (Admin Center): `POST /admin/auth/login` — chỉ tài khoản có role `ADMIN`/`SUPPORT`.

Một tài khoản không thể đăng nhập nhầm cổng (đã test: 401 ở cả 2 chiều).

### Khách hàng
- `POST /auth/register` — `{email,password,fullName,phone?}` → `201 {id,email,fullName,phone,status}`. Luôn gán role `CUSTOMER`, bỏ qua field `role` nếu client gửi lên.
- `POST /auth/login` — `{email,password}` → `200 {accessToken,refreshToken,user}`. Sai 5 lần liên tiếp trong 15 phút → `423 ACCOUNT_LOCKED`.
- `POST /auth/refresh` — `{refreshToken}` → `200 {accessToken}`.
- `POST /auth/logout` — `{refreshToken}` → `200 {success:true}` (thu hồi refresh token).
- `GET /auth/me` — Bearer token → `200 {id,email,fullName,phone,status,role}`.
- `PATCH /auth/me` — Bearer token, `{fullName?,phone?}` (whitelist tuyệt đối, field lạ bị từ chối `422`).
- `PATCH /auth/change-password` — Bearer token, `{currentPassword,newPassword}` → thu hồi toàn bộ refresh token cũ sau khi đổi.

### Nội bộ (Admin Center)
- `POST /admin/auth/login`, `POST /admin/auth/refresh`, `POST /admin/auth/logout` — cùng cấu trúc như trên nhưng chỉ chấp nhận role `ADMIN`/`SUPPORT`.
- `POST /admin/users` (chỉ `ADMIN`) — `{email,fullName,phone?,role:'ADMIN'|'SUPPORT'}` → tạo tài khoản nội bộ mới với mật khẩu mặc định (`Vietjet@123` theo `.env` hiện tại), trả `defaultPassword` một lần để Super Admin bàn giao. Nhân viên nên đổi mật khẩu ngay bằng `PATCH /auth/change-password` sau lần đăng nhập đầu.
- RBAC: `GET/PATCH /admin/chats/*`, `GET/PATCH /admin/reviews/*` — `ADMIN` hoặc `SUPPORT`. Mọi resource admin khác (`promotions`, `notifications`, `flights`, `services`) — chỉ `ADMIN`.

Lỗi trả về đồng nhất `{code,message,details?}`; mã lỗi thường gặp: `VALIDATION`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `REFRESH_TOKEN_INVALID`, `UNAUTHORIZED` (401), `FORBIDDEN` (403).

## Khuyến mãi
- `GET /promotions/active?flightId=&userId=`: danh sách mã áp dụng được.
- `POST /promotions/validate`: kiểm tra mã với booking, trả số tiền giảm và lý do từ chối.
- `POST /admin/promotions`, `PATCH /admin/promotions/{id}`: tạo/cập nhật chương trình.

## Đánh giá
- `POST /reviews`: gửi đánh giá; backend kiểm tra ticket `FLOWN` và mỗi ticket chỉ đánh giá một lần.
- `GET /me/reviews`: đánh giá của khách hàng.
- `GET /admin/reviews`, `PATCH /admin/reviews/{id}/moderation`: duyệt, ẩn hoặc phản hồi.

## Chat
- `POST /chat/conversations`: mở hội thoại theo booking/chủ đề.
- `GET /chat/conversations/{id}/messages`, `POST /chat/conversations/{id}/messages`: tải/gửi tin nhắn.
- `PATCH /admin/chat/conversations/{id}`: phân công nhân viên, đổi trạng thái, đóng hội thoại.
- Khi triển khai thật dùng WebSocket/SSE cho sự kiện `message.created` và `conversation.updated`.

## Thông báo
- `GET /me/notifications`, `PATCH /me/notifications/{id}/read`, `POST /me/notifications/read-all`.
- `POST /admin/notifications`: tạo bản nháp hoặc lịch gửi; `POST /admin/notifications/{id}/send` để gửi.
- Worker đọc `outbox_events`, tạo `notifications` và từng `notification_deliveries` theo kênh.

## Quy tắc bắt buộc
- Mọi POST thanh toán/gửi thông báo hàng loạt dùng `Idempotency-Key`.
- Phân trang bằng `page`, `size`; lọc bằng `status`, `from`, `to`; phản hồi lỗi có `code`, `message`, `details`.
- Không tin giá trị giảm từ frontend; backend tính lại tổng tiền và khóa promotion usage trong transaction.


## Admin Center - Chuyến bay, Khuyến mãi, Dịch vụ (ghi thẳng vào PostgreSQL)

Tất cả cần header `Authorization: Bearer <accessToken admin>`; ADMIN toàn quyền, SUPPORT cần permission tương ứng.

| Method | Đường dẫn | Permission | Mô tả |
|---|---|---|---|
| GET | `/api/v1/admin/meta` | (đã đăng nhập) | Sân bay, máy bay, hạng vé cho ô chọn |
| GET/POST | `/api/v1/admin/flights` | `flights.manage` | Danh sách / tạo chuyến bay (kèm giá từng hạng vé) |
| PATCH/DELETE | `/api/v1/admin/flights/:id` | `flights.manage` | Sửa / xóa (đã có đặt chỗ thì trả 409) |
| PATCH | `/api/v1/admin/flights/:id/status` | `flights.manage` | `OPEN_FOR_SALE` \| `CLOSED` \| `CANCELLED` |
| GET/POST | `/api/v1/admin/services` | `services.manage` | Danh sách / tạo dịch vụ bổ sung |
| PATCH/DELETE | `/api/v1/admin/services/:id` | `services.manage` | Sửa / xóa (đã được dùng thì 409) |
| PATCH | `/api/v1/admin/services/:id/status` | `services.manage` | `ACTIVE` \| `INACTIVE` |
| GET/POST | `/api/v1/admin/promotions` | `promotions.manage` | Danh sách (kèm số lượt đã dùng) / tạo khuyến mãi |
| PATCH/DELETE | `/api/v1/admin/promotions/:id` | `promotions.manage` | Sửa / xóa (đã được dùng thì 409) |
| PATCH | `/api/v1/admin/promotions/:id/status` | `promotions.manage` | `ACTIVE` \| `INACTIVE` |

Body tạo/sửa chuyến bay:
```json
{ "flightNo":"VJ201","origin":"HAN","destination":"SGN",
  "departureTime":"2026-10-20T06:00:00+07:00","arrivalTime":"2026-10-20T08:10:00+07:00",
  "aircraftId":"<uuid>","status":"OPEN_FOR_SALE",
  "fares":[{"code":"ECO","price":1290000,"quota":50},{"code":"DELUXE","price":1790000,"quota":20}] }
```
Chuyến bay chỉ hiện cho khách khi `status = OPEN_FOR_SALE` và còn hạng vé có `quota`.
