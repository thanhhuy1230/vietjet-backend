-- DỮ LIỆU MẪU (tuỳ chọn): tài khoản support/customer, chuyến bay, khuyến mãi, thông báo. Chạy: npm run seed:demo
INSERT INTO users(email,password_hash,full_name,phone,status)
VALUES ('support@vietjet.local',crypt('Vietjet@123',gen_salt('bf',12)),'Trần Hỗ Trợ','0900000002','ACTIVE'),
       ('customer@vietjet.local',crypt('Vietjet@123',gen_salt('bf',12)),'Nguyễn Văn A','0901234567','ACTIVE')
ON CONFLICT(email) DO NOTHING;
INSERT INTO user_roles(user_id,role_id) SELECT u.user_id,r.role_id FROM users u JOIN roles r ON
  (u.email='support@vietjet.local' AND r.code='SUPPORT') OR (u.email='customer@vietjet.local' AND r.code='CUSTOMER') ON CONFLICT DO NOTHING;

INSERT INTO flights(flight_no,origin_id,destination_id,aircraft_id,departure_time,arrival_time,status)
SELECT v.no,o.airport_id,d.airport_id,a.aircraft_id,v.departure,v.arrival,'OPEN_FOR_SALE'
-- Ngày bay tính tương đối từ ngày chạy seed (hôm nay +7/+10/+13) để luôn còn chuyến trong tương lai.
FROM (VALUES ('VJ125','HAN','SGN',((current_date+7)::text||' 06:00+07')::timestamptz,((current_date+7)::text||' 08:15+07')::timestamptz),('VJ131','HAN','SGN',((current_date+7)::text||' 07:30+07')::timestamptz,((current_date+7)::text||' 09:45+07')::timestamptz),('VJ159','HAN','SGN',((current_date+7)::text||' 13:45+07')::timestamptz,((current_date+7)::text||' 16:00+07')::timestamptz),('VJ147','SGN','HAN',((current_date+10)::text||' 09:15+07')::timestamptz,((current_date+10)::text||' 11:30+07')::timestamptz),('VJ503','DAD','HAN',((current_date+13)::text||' 13:45+07')::timestamptz,((current_date+13)::text||' 15:10+07')::timestamptz)) v(no,ori,dst,departure,arrival)
JOIN airports o ON o.iata_code=v.ori JOIN airports d ON d.iata_code=v.dst CROSS JOIN aircraft a WHERE a.registration_no='VN-A678' ON CONFLICT(flight_no,departure_time) DO NOTHING;
INSERT INTO flight_fares(flight_id,fare_class_id,price,quota,status)
SELECT f.flight_id,fc.fare_class_id,CASE fc.code WHEN 'ECO' THEN 1290000 WHEN 'DELUXE' THEN 1790000 ELSE 2490000 END,50,'ACTIVE' FROM flights f CROSS JOIN fare_classes fc ON CONFLICT(flight_id,fare_class_id) DO NOTHING;
INSERT INTO flight_inventory(flight_id,available_seats) SELECT flight_id,60 FROM flights ON CONFLICT(flight_id) DO NOTHING;

INSERT INTO promotions(code,name,discount_type,discount_value,max_discount,min_order,starts_at,ends_at,usage_limit,per_user_limit,status) VALUES
('VJFLASH20','Flash Sale nội địa','PERCENT',20,500000,1000000,'2026-09-01 00:00+07','2026-09-30 23:59+07',1000,1,'ACTIVE'),
('BAGGAGE100','Ưu đãi hành lý','FIXED',100000,100000,500000,'2026-09-01 00:00+07','2026-10-05 23:59+07',500,1,'ACTIVE'),
('WELCOME10','Chào thành viên mới','PERCENT',10,300000,500000,'2026-08-01 00:00+07','2026-12-31 23:59+07',2000,1,'ACTIVE') ON CONFLICT(code) DO NOTHING;

INSERT INTO notifications(user_id,type,title,body,status,sent_at)
SELECT u.user_id,'PROMOTION','Ưu đãi VJFLASH20','Giảm 20% giá vé nội địa đến hết 30/09/2026.','SENT',now() FROM users u WHERE u.email='customer@vietjet.local' AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.user_id=u.user_id AND n.title='Ưu đãi VJFLASH20');

