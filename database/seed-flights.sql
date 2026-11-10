-- =====================================================================
-- SEED CHUYẾN BAY CHO CUSTOMER: tạo chuyến cho MỌI ngày từ hôm nay đến 31/12/2027
-- trên tất cả đường bay giữa 5 sân bay: HAN, SGN, DAD, CXR, PQC (cả 2 chiều).
-- => tìm 1 chiều / khứ hồi / nhiều chặng ở ngày nào cũng có chuyến.
--
-- Chạy:  cd backend && npm run seed:flights      (hoặc dán file này vào pgAdmin > Query Tool)
-- An toàn khi chạy lại (ON CONFLICT DO NOTHING). Chạy lại mỗi khi muốn "kéo dài" thêm ngày.
-- Cần chạy `npm run seed` trước (để có sân bay, máy bay VN-A678, hạng vé).
-- Muốn đổi ngày kết thúc: sửa DATE '2027-12-31' bên dưới.
-- =====================================================================

-- 1) Thêm sân bay Nha Trang (app customer có CXR nhưng seed.sql chưa có)
INSERT INTO airports(iata_code,name,city,timezone) VALUES
('CXR','Sân bay quốc tế Cam Ranh','Nha Trang','Asia/Ho_Chi_Minh') ON CONFLICT(iata_code) DO NOTHING;

-- 2) Bảng khung giờ bay (flight_no, giờ đi theo giờ VN, thời lượng phút, giá Eco cơ sở)
DROP TABLE IF EXISTS _vj_slots;
CREATE TEMP TABLE _vj_slots(ori char(3), dst char(3), flight_no varchar(12), dep char(5), dur int, eco numeric, slot_idx int);
INSERT INTO _vj_slots VALUES
  ('HAN','SGN','VJ125','06:00',135,1290000,0),
  ('HAN','SGN','VJ131','07:30',135,1290000,1),
  ('HAN','SGN','VJ141','09:15',135,1290000,2),
  ('HAN','SGN','VJ159','13:45',135,1290000,3),
  ('HAN','SGN','VJ173','18:10',135,1290000,4),
  ('HAN','DAD','VJ510','06:15',85,790000,0),
  ('HAN','DAD','VJ511','09:30',85,790000,1),
  ('HAN','DAD','VJ512','12:45',85,790000,2),
  ('HAN','DAD','VJ513','16:20',85,790000,3),
  ('HAN','DAD','VJ514','19:30',85,790000,4),
  ('HAN','CXR','VJ200','06:10',125,1090000,0),
  ('HAN','CXR','VJ201','09:20',125,1090000,1),
  ('HAN','CXR','VJ202','12:40',125,1090000,2),
  ('HAN','CXR','VJ203','16:00',125,1090000,3),
  ('HAN','CXR','VJ204','19:15',125,1090000,4),
  ('HAN','PQC','VJ210','06:20',135,1190000,0),
  ('HAN','PQC','VJ211','09:30',135,1190000,1),
  ('HAN','PQC','VJ212','12:50',135,1190000,2),
  ('HAN','PQC','VJ213','16:10',135,1190000,3),
  ('HAN','PQC','VJ214','19:25',135,1190000,4),
  ('SGN','HAN','VJ126','06:30',135,1290000,0),
  ('SGN','HAN','VJ147','09:15',135,1290000,1),
  ('SGN','HAN','VJ152','12:00',135,1290000,2),
  ('SGN','HAN','VJ160','15:30',135,1290000,3),
  ('SGN','HAN','VJ174','19:45',135,1290000,4),
  ('SGN','DAD','VJ220','06:30',80,890000,0),
  ('SGN','DAD','VJ221','09:40',80,890000,1),
  ('SGN','DAD','VJ222','13:00',80,890000,2),
  ('SGN','DAD','VJ223','16:20',80,890000,3),
  ('SGN','DAD','VJ224','19:35',80,890000,4),
  ('SGN','CXR','VJ230','06:40',55,590000,0),
  ('SGN','CXR','VJ231','09:50',55,590000,1),
  ('SGN','CXR','VJ232','13:10',55,590000,2),
  ('SGN','CXR','VJ233','16:30',55,590000,3),
  ('SGN','CXR','VJ234','19:45',55,590000,4),
  ('SGN','PQC','VJ240','06:10',60,650000,0),
  ('SGN','PQC','VJ241','09:20',60,650000,1),
  ('SGN','PQC','VJ242','12:40',60,650000,2),
  ('SGN','PQC','VJ243','16:00',60,650000,3),
  ('SGN','PQC','VJ244','19:15',60,650000,4),
  ('DAD','HAN','VJ501','07:00',85,790000,0),
  ('DAD','HAN','VJ502','10:15',85,790000,1),
  ('DAD','HAN','VJ503','13:45',85,790000,2),
  ('DAD','HAN','VJ504','17:30',85,790000,3),
  ('DAD','HAN','VJ505','20:40',85,790000,4),
  ('DAD','SGN','VJ250','06:20',80,890000,0),
  ('DAD','SGN','VJ251','09:30',80,890000,1),
  ('DAD','SGN','VJ252','12:50',80,890000,2),
  ('DAD','SGN','VJ253','16:10',80,890000,3),
  ('DAD','SGN','VJ254','19:25',80,890000,4),
  ('DAD','CXR','VJ260','06:30',75,790000,0),
  ('DAD','CXR','VJ261','09:40',75,790000,1),
  ('DAD','CXR','VJ262','13:00',75,790000,2),
  ('DAD','CXR','VJ263','16:20',75,790000,3),
  ('DAD','CXR','VJ264','19:35',75,790000,4),
  ('DAD','PQC','VJ270','06:40',105,990000,0),
  ('DAD','PQC','VJ271','09:50',105,990000,1),
  ('DAD','PQC','VJ272','13:10',105,990000,2),
  ('DAD','PQC','VJ273','16:30',105,990000,3),
  ('DAD','PQC','VJ274','19:45',105,990000,4),
  ('CXR','HAN','VJ280','06:10',125,1090000,0),
  ('CXR','HAN','VJ281','09:20',125,1090000,1),
  ('CXR','HAN','VJ282','12:40',125,1090000,2),
  ('CXR','HAN','VJ283','16:00',125,1090000,3),
  ('CXR','HAN','VJ284','19:15',125,1090000,4),
  ('CXR','SGN','VJ290','06:20',55,590000,0),
  ('CXR','SGN','VJ291','09:30',55,590000,1),
  ('CXR','SGN','VJ292','12:50',55,590000,2),
  ('CXR','SGN','VJ293','16:10',55,590000,3),
  ('CXR','SGN','VJ294','19:25',55,590000,4),
  ('CXR','DAD','VJ300','06:30',75,790000,0),
  ('CXR','DAD','VJ301','09:40',75,790000,1),
  ('CXR','DAD','VJ302','13:00',75,790000,2),
  ('CXR','DAD','VJ303','16:20',75,790000,3),
  ('CXR','DAD','VJ304','19:35',75,790000,4),
  ('CXR','PQC','VJ310','06:40',70,890000,0),
  ('CXR','PQC','VJ311','09:50',70,890000,1),
  ('CXR','PQC','VJ312','13:10',70,890000,2),
  ('CXR','PQC','VJ313','16:30',70,890000,3),
  ('CXR','PQC','VJ314','19:45',70,890000,4),
  ('PQC','HAN','VJ320','06:10',135,1190000,0),
  ('PQC','HAN','VJ321','09:20',135,1190000,1),
  ('PQC','HAN','VJ322','12:40',135,1190000,2),
  ('PQC','HAN','VJ323','16:00',135,1190000,3),
  ('PQC','HAN','VJ324','19:15',135,1190000,4),
  ('PQC','SGN','VJ330','06:20',60,650000,0),
  ('PQC','SGN','VJ331','09:30',60,650000,1),
  ('PQC','SGN','VJ332','12:50',60,650000,2),
  ('PQC','SGN','VJ333','16:10',60,650000,3),
  ('PQC','SGN','VJ334','19:25',60,650000,4),
  ('PQC','DAD','VJ340','06:30',105,990000,0),
  ('PQC','DAD','VJ341','09:40',105,990000,1),
  ('PQC','DAD','VJ342','13:00',105,990000,2),
  ('PQC','DAD','VJ343','16:20',105,990000,3),
  ('PQC','DAD','VJ344','19:35',105,990000,4),
  ('PQC','CXR','VJ350','06:40',70,890000,0),
  ('PQC','CXR','VJ351','09:50',70,890000,1),
  ('PQC','CXR','VJ352','13:10',70,890000,2),
  ('PQC','CXR','VJ353','16:30',70,890000,3),
  ('PQC','CXR','VJ354','19:45',70,890000,4);

-- 3) Chuyến bay: mỗi khung giờ x mỗi ngày (bỏ qua chuyến đã qua giờ khởi hành)
INSERT INTO flights(flight_no,origin_id,destination_id,aircraft_id,departure_time,arrival_time,status)
SELECT x.flight_no,x.origin_id,x.destination_id,x.aircraft_id,x.dep_ts,x.dep_ts+make_interval(mins=>x.dur),'OPEN_FOR_SALE'
FROM (
  SELECT s.flight_no,o.airport_id origin_id,d.airport_id destination_id,a.aircraft_id,s.dur,
         ((current_date+g.n)::text||' '||s.dep||'+07')::timestamptz dep_ts
  FROM _vj_slots s
  JOIN airports o ON o.iata_code=s.ori
  JOIN airports d ON d.iata_code=s.dst
  CROSS JOIN aircraft a
  CROSS JOIN generate_series(0, GREATEST(DATE '2027-12-31'-current_date,0)) g(n)
  WHERE a.registration_no='VN-A678'
) x
WHERE x.dep_ts>now()
ON CONFLICT(flight_no,departure_time) DO NOTHING;

-- 4) Hạng vé Eco / Deluxe / SkyBoss cho các chuyến chưa có giá
--    Giá Eco = giá cơ sở x hệ số khung giờ x hệ số cuối tuần (Thứ 6, CN +10%); Deluxe = Eco x1.4; SkyBoss = Eco x1.95
INSERT INTO flight_fares(flight_id,fare_class_id,price,quota,status)
SELECT f.flight_id,fc.fare_class_id,
  CASE fc.code WHEN 'ECO' THEN eco.p WHEN 'DELUXE' THEN round(eco.p*1.4/10000)*10000 ELSE round(eco.p*1.95/10000)*10000 END,
  CASE fc.code WHEN 'ECO' THEN 40 WHEN 'DELUXE' THEN 15 ELSE 5 END,'ACTIVE'
FROM flights f
JOIN _vj_slots s ON s.flight_no=f.flight_no AND to_char(f.departure_time AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI')=s.dep
CROSS JOIN fare_classes fc
CROSS JOIN LATERAL (SELECT round(s.eco*(CASE s.slot_idx WHEN 0 THEN 1.00 WHEN 1 THEN 0.95 WHEN 2 THEN 1.00 WHEN 3 THEN 1.10 ELSE 1.20 END)
                         *(CASE WHEN extract(isodow FROM f.departure_time AT TIME ZONE 'Asia/Ho_Chi_Minh') IN (5,7) THEN 1.10 ELSE 1.00 END)/10000)*10000 p) eco
WHERE fc.code IN ('ECO','DELUXE','SKYBOSS')
  AND NOT EXISTS(SELECT 1 FROM flight_fares ff WHERE ff.flight_id=f.flight_id)
ON CONFLICT(flight_id,fare_class_id) DO NOTHING;

-- 5) Số ghế còn trống (A321neo 60 ghế)
INSERT INTO flight_inventory(flight_id,available_seats) SELECT flight_id,60 FROM flights ON CONFLICT(flight_id) DO NOTHING;

DROP TABLE IF EXISTS _vj_slots;
