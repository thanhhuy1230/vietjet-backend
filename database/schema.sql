-- PostgreSQL 15+ - Vietjet thesis system (37 tables)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE roles (role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(30) UNIQUE NOT NULL, name varchar(100) NOT NULL);
CREATE TABLE users (user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(255) UNIQUE NOT NULL, password_hash text NOT NULL, full_name varchar(150) NOT NULL, phone varchar(30), status varchar(20) NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE user_roles (user_id uuid REFERENCES users ON DELETE CASCADE, role_id uuid REFERENCES roles ON DELETE RESTRICT, PRIMARY KEY(user_id,role_id));
CREATE TABLE refresh_tokens (token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
-- UC-00 Auth: khoá tạm thời sau nhiều lần đăng nhập sai (xem docs/DEPLOYMENT.md / phase1-analyze.md mục 7)
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
-- UC-00 Auth: đăng nhập khách hàng chuyển sang số điện thoại + Firebase Phone Auth.
-- email/password_hash trở thành optional (khách hàng đăng nhập bằng phone không có password nội bộ;
-- nội bộ ADMIN/SUPPORT vẫn dùng email+password như cũ, 2 cột này với họ vẫn luôn có giá trị).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_phone_unique') THEN
    ALTER TABLE users ADD CONSTRAINT users_phone_unique UNIQUE(phone);
  END IF;
END $$;
-- UC-00 Auth: OTP tự triển khai ở backend (thay Firebase Phone Auth - không chạy được trong Expo Go,
-- xem giải thích trong hội thoại). Mỗi lần request OTP tạo 1 dòng mới; verify xong đánh dấu consumed_at.
CREATE TABLE IF NOT EXISTS phone_otps (
  otp_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone varchar(30) NOT NULL,
  otp_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_otps_phone ON phone_otps(phone, created_at DESC);
-- purpose tách OTP đăng nhập ('login') và đăng ký ('signup'): OTP của luồng này không dùng được cho luồng kia.
ALTER TABLE phone_otps ADD COLUMN IF NOT EXISTS purpose varchar(20) NOT NULL DEFAULT 'login';
CREATE INDEX IF NOT EXISTS idx_phone_otps_phone_purpose ON phone_otps(phone, purpose, created_at DESC);
CREATE TABLE airports (airport_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), iata_code char(3) UNIQUE NOT NULL, name varchar(150) NOT NULL, city varchar(100) NOT NULL, timezone varchar(60) NOT NULL, status varchar(20) NOT NULL DEFAULT 'ACTIVE');
CREATE TABLE aircraft (aircraft_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), registration_no varchar(20) UNIQUE NOT NULL, model varchar(80) NOT NULL, status varchar(20) NOT NULL);
CREATE TABLE seats (seat_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aircraft_id uuid NOT NULL REFERENCES aircraft ON DELETE RESTRICT, seat_no varchar(8) NOT NULL, cabin_class varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'ACTIVE', UNIQUE(aircraft_id,seat_no));
CREATE TABLE fare_classes (fare_class_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(20) UNIQUE NOT NULL, name varchar(80) NOT NULL, conditions jsonb NOT NULL DEFAULT '{}');
CREATE TABLE flights (flight_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flight_no varchar(12) NOT NULL, origin_id uuid NOT NULL REFERENCES airports, destination_id uuid NOT NULL REFERENCES airports, aircraft_id uuid REFERENCES aircraft, departure_time timestamptz NOT NULL, arrival_time timestamptz NOT NULL, status varchar(30) NOT NULL, version integer NOT NULL DEFAULT 0, CHECK(origin_id<>destination_id), CHECK(arrival_time>departure_time), UNIQUE(flight_no,departure_time));
CREATE INDEX idx_flight_search ON flights(origin_id,destination_id,departure_time,status);
CREATE TABLE flight_fares (flight_fare_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flight_id uuid NOT NULL REFERENCES flights ON DELETE CASCADE, fare_class_id uuid NOT NULL REFERENCES fare_classes, price numeric(18,2) NOT NULL CHECK(price>=0), currency char(3) NOT NULL DEFAULT 'VND', quota integer NOT NULL CHECK(quota>=0), status varchar(20) NOT NULL, UNIQUE(flight_id,fare_class_id));
CREATE TABLE flight_inventory (flight_id uuid PRIMARY KEY REFERENCES flights ON DELETE CASCADE, available_seats integer NOT NULL CHECK(available_seats>=0), version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ancillary_services (service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(30) UNIQUE NOT NULL, type varchar(30) NOT NULL, name varchar(120) NOT NULL, base_price numeric(18,2) NOT NULL CHECK(base_price>=0), status varchar(20) NOT NULL);
CREATE TABLE bookings (booking_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pnr char(6) UNIQUE NOT NULL, user_id uuid REFERENCES users, status varchar(30) NOT NULL, total_amount numeric(18,2) NOT NULL CHECK(total_amount>=0), currency char(3) NOT NULL DEFAULT 'VND', expires_at timestamptz, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE booking_segments (segment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES bookings ON DELETE RESTRICT, flight_id uuid NOT NULL REFERENCES flights, fare_class_id uuid NOT NULL REFERENCES fare_classes, subtotal numeric(18,2) NOT NULL CHECK(subtotal>=0));
CREATE TABLE passengers (passenger_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES bookings ON DELETE RESTRICT, full_name varchar(150) NOT NULL, dob date, document_no_encrypted text, nationality char(2));
CREATE TABLE seat_holds (hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flight_id uuid NOT NULL REFERENCES flights, seat_id uuid NOT NULL REFERENCES seats, token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, status varchar(20) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uq_active_seat_hold ON seat_holds(flight_id,seat_id) WHERE status='ACTIVE';
CREATE TABLE booking_services (booking_service_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), segment_id uuid NOT NULL REFERENCES booking_segments, passenger_id uuid NOT NULL REFERENCES passengers, service_id uuid NOT NULL REFERENCES ancillary_services, qty integer NOT NULL CHECK(qty>0), unit_price numeric(18,2) NOT NULL CHECK(unit_price>=0));
CREATE TABLE payments (payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES bookings, provider varchar(30) NOT NULL, amount numeric(18,2) NOT NULL CHECK(amount>=0), refunded_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK(refunded_amount>=0 AND refunded_amount<=amount), status varchar(30) NOT NULL, idempotency_key varchar(100) UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE payment_events (event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES payments, provider_event_id varchar(150) UNIQUE NOT NULL, payload_hash text NOT NULL, status varchar(30) NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tickets (ticket_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_no varchar(30) UNIQUE NOT NULL, segment_id uuid NOT NULL REFERENCES booking_segments, passenger_id uuid NOT NULL REFERENCES passengers, status varchar(30) NOT NULL, fare_snapshot jsonb NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE outbox_events (outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aggregate_id uuid NOT NULL, event_type varchar(80) NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE check_ins (check_in_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid UNIQUE NOT NULL REFERENCES tickets, checked_in_at timestamptz NOT NULL DEFAULT now(), channel varchar(30) NOT NULL, status varchar(20) NOT NULL);
CREATE TABLE seat_assignments (assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flight_id uuid NOT NULL REFERENCES flights, seat_id uuid NOT NULL REFERENCES seats, ticket_id uuid UNIQUE NOT NULL REFERENCES tickets, status varchar(20) NOT NULL, UNIQUE(flight_id,seat_id));
CREATE TABLE boarding_passes (boarding_pass_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_in_id uuid UNIQUE NOT NULL REFERENCES check_ins, barcode_token_hash text UNIQUE NOT NULL, gate varchar(20), boarding_time timestamptz, issued_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE refund_requests (refund_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES bookings, payment_id uuid NOT NULL REFERENCES payments, amount numeric(18,2) NOT NULL CHECK(amount>=0), fee numeric(18,2) NOT NULL DEFAULT 0 CHECK(fee>=0), status varchar(30) NOT NULL, requested_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE refund_items (refund_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), refund_id uuid NOT NULL REFERENCES refund_requests, ticket_id uuid NOT NULL REFERENCES tickets, amount numeric(18,2) NOT NULL CHECK(amount>=0), UNIQUE(refund_id,ticket_id));
CREATE TABLE refund_events (event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), refund_id uuid NOT NULL REFERENCES refund_requests, provider_event_id varchar(150) UNIQUE, status varchar(30) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE flight_status_history (history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flight_id uuid NOT NULL REFERENCES flights, from_status varchar(30), to_status varchar(30) NOT NULL, changed_by uuid REFERENCES users, changed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_logs (audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users, action varchar(80) NOT NULL, entity_type varchar(80) NOT NULL, entity_id uuid, payload_hash text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE promotions (promotion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(40) UNIQUE NOT NULL, name varchar(150) NOT NULL, discount_type varchar(20) NOT NULL CHECK(discount_type IN ('PERCENT','FIXED')), discount_value numeric(18,2) NOT NULL CHECK(discount_value>0), max_discount numeric(18,2), min_order numeric(18,2) NOT NULL DEFAULT 0, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, usage_limit integer, per_user_limit integer NOT NULL DEFAULT 1, status varchar(20) NOT NULL, CHECK(ends_at>starts_at));
CREATE TABLE promotion_usages (usage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), promotion_id uuid NOT NULL REFERENCES promotions, booking_id uuid UNIQUE NOT NULL REFERENCES bookings, user_id uuid REFERENCES users, discount_amount numeric(18,2) NOT NULL CHECK(discount_amount>=0), used_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_promotion_user ON promotion_usages(promotion_id,user_id);
CREATE TABLE reviews (review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, ticket_id uuid UNIQUE NOT NULL REFERENCES tickets, rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5), content varchar(1000), status varchar(20) NOT NULL DEFAULT 'PENDING', admin_reply varchar(1000), created_at timestamptz NOT NULL DEFAULT now(), moderated_at timestamptz);
CREATE TABLE chat_conversations (conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users, booking_id uuid REFERENCES bookings, topic varchar(120), status varchar(20) NOT NULL DEFAULT 'OPEN', assigned_agent_id uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz);
CREATE TABLE chat_messages (message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES chat_conversations ON DELETE CASCADE, sender_id uuid REFERENCES users, sender_type varchar(20) NOT NULL CHECK(sender_type IN ('CUSTOMER','AGENT','BOT','SYSTEM')), body varchar(2000) NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz);
CREATE INDEX idx_chat_messages ON chat_messages(conversation_id,sent_at);
CREATE TABLE notifications (notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users, booking_id uuid REFERENCES bookings, type varchar(50) NOT NULL, title varchar(200) NOT NULL, body varchar(2000) NOT NULL, data jsonb NOT NULL DEFAULT '{}', status varchar(20) NOT NULL DEFAULT 'QUEUED', scheduled_at timestamptz, sent_at timestamptz, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_notifications_user ON notifications(user_id,created_at DESC);
CREATE TABLE notification_deliveries (delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_id uuid NOT NULL REFERENCES notifications ON DELETE CASCADE, channel varchar(20) NOT NULL CHECK(channel IN ('IN_APP','EMAIL','PUSH','SMS')), provider_message_id varchar(150), status varchar(20) NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(), error_message text, UNIQUE(notification_id,channel));
CREATE TABLE notification_preferences (user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE, email_enabled boolean NOT NULL DEFAULT true, push_enabled boolean NOT NULL DEFAULT true, sms_enabled boolean NOT NULL DEFAULT false, marketing_enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
-- UC-00 Auth: lưu ngày sinh khách hàng – dùng để khớp giấy tờ tùy thân khi đặt vé, check-in,
-- giống hãng hàng không thật. Thêm bước "hoàn thiện hồ sơ" khi đăng nhập OTP lần đầu.
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth date;

-- RBAC permission-based: cho phép ADMIN gán chi tiết quyền truy cập từng module cho SUPPORT.
-- ADMIN luôn bypass toàn bộ permission check (Super Admin). SUPPORT chỉ truy cập được module
-- nào được gán permission tương ứng. Permission nằm trong JWT payload → chỉ có hiệu lực sau
-- khi đăng nhập/refresh lại.
CREATE TABLE IF NOT EXISTS permissions (
  permission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(50) UNIQUE NOT NULL,
  name varchar(150) NOT NULL
);
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id uuid REFERENCES users ON DELETE CASCADE,
  permission_id uuid REFERENCES permissions ON DELETE CASCADE,
  PRIMARY KEY (user_id, permission_id)
);

-- SKYJOY (khách hàng thân thiết) - giống phần cuối upgrade.sql; cột points_redeemed/points_discount của bookings được thêm ở upgrade.sql
CREATE TABLE IF NOT EXISTS loyalty_accounts (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  member_no varchar(20) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
