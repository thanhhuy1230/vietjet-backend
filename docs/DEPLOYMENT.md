# Hướng dẫn triển khai thực tế

## 1. Chạy trên máy cá nhân với PostgreSQL và pgAdmin 4

1. Cài Node.js 22 LTS, PostgreSQL 16 và pgAdmin 4.
2. Trong pgAdmin 4, tạo database tên `vietjet` với UTF-8.
3. Mở Query Tool của database `vietjet`, chạy lần lượt `database/schema.sql` và `database/seed.sql`.
4. Sao chép `backend/.env.example` thành `backend/.env`, sửa `DATABASE_URL` và đặt `JWT_SECRET` ngẫu nhiên tối thiểu 32 ký tự.
5. Mở terminal tại `backend`, chạy `npm install`, sau đó `npm start`.
6. Truy cập `http://localhost:3000` và `http://localhost:3000/admin`.

## 2. Kết nối pgAdmin 4

Tạo Server mới với Host `localhost`, Port `5432`, Maintenance database `vietjet`, Username `vietjet` và mật khẩu đã cấu hình. Nếu chạy PostgreSQL bằng Docker Compose thì dùng các giá trị trong `docker-compose.yml`.

## 3. Triển khai bằng Docker Compose

Chạy `docker compose up -d --build`. Trước khi triển khai công khai, đổi `POSTGRES_PASSWORD`, `DATABASE_URL` và `JWT_SECRET`; bỏ port 5432 ra Internet; đặt reverse proxy HTTPS trước port 3000; giới hạn CORS về domain thật.

## 4. Sao lưu và phục hồi

Sao lưu: `pg_dump -Fc -d vietjet -f vietjet.backup`. Phục hồi vào database trống: `pg_restore --clean --if-exists -d vietjet vietjet.backup`. Lập lịch sao lưu hằng ngày và thử phục hồi định kỳ.

## 5. Việc cần làm trước production

- Thay cổng thanh toán demo bằng sandbox chính thức và xác minh chữ ký callback.
- Dùng Redis cho khóa giữ ghế TTL và hàng đợi cho Email/SMS/Push.
- Lưu secret trong secret manager, bật PostgreSQL TLS và mã hóa bản sao lưu.
- Thêm rate limit, xác minh email, refresh token rotation và nhật ký giám sát.
- Chạy migration có phiên bản thay vì sửa trực tiếp schema; dùng CI để chạy test và kiểm tra lỗ hổng.
- Dùng object storage cho vé/boarding pass; không lưu số thẻ hoặc CVV.

## 6. API chính

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`
- `GET /api/v1/flights/search`, `GET /api/v1/flights/:id/fares`
- `GET /api/v1/promotions/active`, `POST /api/v1/promotions/validate`
- `POST /api/v1/bookings`, `GET /api/v1/bookings/mine`, `POST /api/v1/bookings/:id/payments`
- `GET/POST /api/v1/reviews`
- `GET/POST /api/v1/chat/conversations` và `/messages`
- `GET/PATCH /api/v1/notifications`
- `/api/v1/admin/*` yêu cầu JWT có vai trò `ADMIN`
