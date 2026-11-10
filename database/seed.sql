-- DỮ LIỆU NỀN (bắt buộc): vai trò, quyền, 1 tài khoản ADMIN, sân bay, máy bay, hạng vé, dịch vụ. KHÔNG có chuyến bay/khách hàng mẫu.
INSERT INTO roles(code,name) VALUES ('ADMIN','Quản trị viên'),('SUPPORT','Nhân viên hỗ trợ'),('CUSTOMER','Khách hàng') ON CONFLICT(code) DO NOTHING;

INSERT INTO users(email,password_hash,full_name,phone,status)
VALUES ('admin@vietjet.local',crypt('Vietjet@123',gen_salt('bf',12)),'Quản trị viên','0900000001','ACTIVE')
ON CONFLICT(email) DO NOTHING;
-- Tài khoản nội bộ (ADMIN/SUPPORT) KHÔNG có role CUSTOMER -> không đăng nhập được qua /api/v1/auth/login của khách hàng.
INSERT INTO user_roles(user_id,role_id) SELECT u.user_id,r.role_id FROM users u JOIN roles r ON
  (u.email='admin@vietjet.local' AND r.code='ADMIN') ON CONFLICT DO NOTHING;

INSERT INTO airports(iata_code,name,city,timezone) VALUES
('HAN','Sân bay quốc tế Nội Bài','Hà Nội','Asia/Ho_Chi_Minh'),('SGN','Sân bay quốc tế Tân Sơn Nhất','TP. Hồ Chí Minh','Asia/Ho_Chi_Minh'),('DAD','Sân bay quốc tế Đà Nẵng','Đà Nẵng','Asia/Ho_Chi_Minh'),('PQC','Sân bay quốc tế Phú Quốc','Phú Quốc','Asia/Ho_Chi_Minh') ON CONFLICT(iata_code) DO NOTHING;
INSERT INTO aircraft(registration_no,model,status) VALUES('VN-A678','Airbus A321neo','ACTIVE') ON CONFLICT(registration_no) DO NOTHING;
INSERT INTO seats(aircraft_id,seat_no,cabin_class,status)
SELECT a.aircraft_id,(r::text||c)::varchar,'ECONOMY','ACTIVE' FROM aircraft a CROSS JOIN generate_series(1,10) r CROSS JOIN unnest(ARRAY['A','B','C','D','E','F']) c WHERE a.registration_no='VN-A678' ON CONFLICT DO NOTHING;
INSERT INTO fare_classes(code,name,conditions) VALUES('ECO','Eco','{"baggageKg":0,"change":"FEE"}'),('DELUXE','Deluxe','{"baggageKg":20,"change":"FREE"}'),('SKYBOSS','SkyBoss','{"baggageKg":30,"change":"FREE"}') ON CONFLICT(code) DO NOTHING;
INSERT INTO ancillary_services(code,type,name,base_price,status) VALUES('BAG20','BAGGAGE','Hành lý 20kg',350000,'ACTIVE'),('MEAL01','MEAL','Suất ăn nóng',95000,'ACTIVE'),('SEATFR','SEAT','Ghế hàng đầu',180000,'ACTIVE'),('INSURE','INSURANCE','Bảo hiểm chuyến bay',79000,'ACTIVE') ON CONFLICT(code) DO NOTHING;

-- RBAC permissions: 6 module cố định cho hệ thống admin, dùng ON CONFLICT(code) DO NOTHING.
-- ADMIN luôn bypass toàn bộ permission → không cần gán. SUPPORT được gán qua UI bởi ADMIN.
INSERT INTO permissions(code, name) VALUES
  ('promotions.manage', 'Quản lý khuyến mãi'),
  ('notifications.manage', 'Quản lý thông báo'),
  ('flights.manage', 'Quản lý chuyến bay'),
  ('services.manage', 'Quản lý dịch vụ'),
  ('chats.manage', 'Quản lý hội thoại hỗ trợ'),
  ('reviews.manage', 'Quản lý đánh giá'),
  ('routes.manage', 'Quản lý tuyến bay & sân bay'),
  ('aircraft.manage', 'Quản lý máy bay'),
  ('fares.manage', 'Quản lý hạng vé / giá vé'),
  ('customers.manage', 'Quản lý khách hàng'),
  ('revenue.view', 'Xem doanh thu & xuất báo cáo')
ON CONFLICT(code) DO NOTHING;
-- Sức chứa máy bay (cột thêm bởi upgrade.sql - chạy `npm run migrate` trước `npm run seed`)
UPDATE aircraft SET seat_capacity=60 WHERE registration_no='VN-A678' AND seat_capacity IS NULL;
