-- Nâng cấp schema (idempotent - chạy lại nhiều lần an toàn, không mất dữ liệu). Được gọi tự động bởi `npm run migrate`.
ALTER TABLE ancillary_services ADD COLUMN IF NOT EXISTS unit varchar(40);
ALTER TABLE ancillary_services ADD COLUMN IF NOT EXISTS description varchar(500);
UPDATE ancillary_services SET unit = CASE type WHEN 'BAGGAGE' THEN 'Mỗi chặng' WHEN 'SEAT' THEN 'Mỗi chặng' WHEN 'MEAL' THEN 'Mỗi suất' ELSE 'Mỗi khách' END WHERE unit IS NULL;
-- UC-00 Auth: tách OTP đăng nhập / đăng ký (purpose = 'login' | 'signup'). Dòng OTP cũ mặc định là 'login'.
ALTER TABLE phone_otps ADD COLUMN IF NOT EXISTS purpose varchar(20) NOT NULL DEFAULT 'login';
CREATE INDEX IF NOT EXISTS idx_phone_otps_phone_purpose ON phone_otps(phone, purpose, created_at DESC);
-- Hồ sơ khách hàng: ngày sinh (phòng DB cũ chưa có), quê quán, số căn cước công dân (CCCD 12 số).
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hometown varchar(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id varchar(20);

-- Ghế đã đặt theo từng chuyến bay: ghế đang được giữ/đã bán thì người khác không đặt được nữa.
-- status: ACTIVE = đang giữ (booking chờ thanh toán còn hạn hoặc đã xác nhận); RELEASED = đã nhả (hủy vé / hết hạn giữ chỗ).
-- Chỉ mục duy nhất một phần bên dưới bảo đảm DB không bao giờ có 2 ghế ACTIVE trùng (flight_id, seat_code), kể cả khi 2 người bấm đặt cùng lúc.
CREATE TABLE IF NOT EXISTS booking_seats (
  booking_seat_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings ON DELETE CASCADE,
  segment_id uuid NOT NULL REFERENCES booking_segments ON DELETE CASCADE,
  passenger_id uuid REFERENCES passengers ON DELETE SET NULL,
  flight_id uuid NOT NULL REFERENCES flights,
  seat_code varchar(4) NOT NULL,
  seat_type varchar(30),
  price numeric(18,2) NOT NULL DEFAULT 0 CHECK(price>=0),
  status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_seat_active ON booking_seats(flight_id, seat_code) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS idx_booking_seats_booking ON booking_seats(booking_id);

-- =====================================================================
-- ĐỒNG BỘ ADMIN ↔ CUSTOMER ↔ BACKEND (mọi màn hình chạy dữ liệu thật trong PostgreSQL)
-- Idempotent: chạy lại nhiều lần an toàn, không xóa dữ liệu. Được gọi tự động bởi `npm run migrate`.
-- =====================================================================

-- Sân bay: thêm quốc gia để phân loại tuyến nội địa / quốc tế.
ALTER TABLE airports ADD COLUMN IF NOT EXISTS country varchar(60) NOT NULL DEFAULT 'Việt Nam';

-- Máy bay: thông tin quản lý đội bay (trước đây chỉ có trên dữ liệu mẫu của trang admin).
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS seat_capacity integer CHECK (seat_capacity IS NULL OR seat_capacity > 0);
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS manufacture_year integer;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS flight_hours numeric(10,1) NOT NULL DEFAULT 0;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS next_maintenance date;
UPDATE aircraft a SET seat_capacity = s.n FROM (SELECT aircraft_id, count(*)::int n FROM seats WHERE status='ACTIVE' GROUP BY aircraft_id) s
 WHERE s.aircraft_id = a.aircraft_id AND a.seat_capacity IS NULL;

-- Tuyến bay: bảng mới cho trang "Quản lý tuyến bay".
CREATE TABLE IF NOT EXISTS routes (
  route_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_id uuid NOT NULL REFERENCES airports ON DELETE RESTRICT,
  destination_id uuid NOT NULL REFERENCES airports ON DELETE RESTRICT,
  distance_km integer CHECK (distance_km IS NULL OR distance_km > 0),
  duration_min integer CHECK (duration_min IS NULL OR duration_min > 0),
  status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (origin_id <> destination_id),
  UNIQUE (origin_id, destination_id)
);
-- Tạo sẵn tuyến từ các chuyến bay đang có trong database (thời gian bay = trung bình thực tế).
INSERT INTO routes(origin_id, destination_id, duration_min)
SELECT origin_id, destination_id, round(avg(extract(epoch FROM (arrival_time - departure_time)) / 60))::int
  FROM flights GROUP BY origin_id, destination_id
ON CONFLICT (origin_id, destination_id) DO NOTHING;

-- Hạng vé: trạng thái + mô tả cho trang "Quản lý giá vé".
ALTER TABLE fare_classes ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE fare_classes ADD COLUMN IF NOT EXISTS description varchar(500);

-- Thông báo: gom các thông báo gửi hàng loạt (1 dòng / khách) thành 1 chiến dịch để admin quản lý.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS campaign_id uuid;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_campaign ON notifications(campaign_id);

-- Phân quyền module mới cho nhân viên SUPPORT.
INSERT INTO permissions(code, name) VALUES
  ('routes.manage',    'Quản lý tuyến bay & sân bay'),
  ('aircraft.manage',  'Quản lý máy bay'),
  ('fares.manage',     'Quản lý hạng vé / giá vé'),
  ('customers.manage', 'Quản lý khách hàng')
ON CONFLICT (code) DO NOTHING;

-- Vé điện tử: phát hành cho các booking ĐÃ XÁC NHẬN trước đây nhưng chưa có vé (để đánh giá / check-in chạy được).
INSERT INTO tickets(ticket_no, segment_id, passenger_id, status, fare_snapshot)
SELECT '981' || to_char(now(), 'YYMMDD') || upper(substr(md5(random()::text || bs.segment_id::text || p.passenger_id::text), 1, 8)),
       bs.segment_id, p.passenger_id, 'ISSUED',
       jsonb_build_object('fareClass', fc.code, 'price', round(bs.subtotal / greatest(1, (SELECT count(*) FROM passengers x WHERE x.booking_id = b.booking_id))))
  FROM bookings b
  JOIN booking_segments bs ON bs.booking_id = b.booking_id
  JOIN fare_classes fc ON fc.fare_class_id = bs.fare_class_id
  JOIN passengers p ON p.booking_id = b.booking_id
 WHERE b.status = 'CONFIRMED'
   AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.segment_id = bs.segment_id AND t.passenger_id = p.passenger_id);

-- Trang Doanh thu (thay Tổng quan): xem doanh thu theo tháng, theo chuyến bay, xuất Excel.
INSERT INTO permissions(code, name) VALUES ('revenue.view', 'Xem doanh thu & xuất báo cáo') ON CONFLICT (code) DO NOTHING;

-- =====================================================================
-- SKYJOY - chương trình khách hàng thân thiết (Mở rộng 3)
-- Mọi tài khoản khách hàng là hội viên. Điểm tích theo số tiền thực trả, dùng điểm để giảm giá khi đặt vé.
-- Quy tắc (tỷ lệ tích/đổi, hạng) đặt trong .env - xem backend/src/utils/loyalty.js.
-- =====================================================================
CREATE TABLE IF NOT EXISTS loyalty_accounts (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  member_no varchar(20) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Mỗi dòng là một biến động điểm (có dấu): EARN tích điểm (+), REDEEM dùng điểm (-), REFUND hoàn điểm (+), ADJUST điều chỉnh.
-- status: PENDING (chờ cộng - chuyến chưa bay) | AVAILABLE (đã có hiệu lực) | HELD (đang giữ cho booking chờ thanh toán) | CANCELLED
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  txn_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings ON DELETE SET NULL,
  type varchar(10) NOT NULL CHECK (type IN ('EARN','REDEEM','REFUND','ADJUST')),
  points integer NOT NULL,
  status varchar(10) NOT NULL CHECK (status IN ('PENDING','AVAILABLE','HELD','CANCELLED')),
  available_at timestamptz,
  note varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_txn_user ON loyalty_transactions(user_id, created_at DESC);
-- Mỗi booking chỉ tích điểm 1 lần
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_earn_booking ON loyalty_transactions(booking_id) WHERE type = 'EARN';
-- Số điểm đã dùng và số tiền được giảm của từng booking
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS points_redeemed integer NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS points_discount numeric(12,2) NOT NULL DEFAULT 0;
