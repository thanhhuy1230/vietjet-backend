const router=require('express').Router();const db=require('../db');const {releaseStale}=require('../utils/seats');const {auth}=require('../middleware/auth');

// GET /api/v1/flights/search?from=HAN&to=SGN&date=2026-09-12&passengers=2&sort=price
// Tìm chuyến bay theo điểm đi, điểm đến, ngày bay và số hành khách.
// Giờ/ngày bay luôn tính theo giờ Việt Nam (Asia/Ho_Chi_Minh), không phụ thuộc múi giờ của PostgreSQL.
// Chỉ trả về chuyến còn tối thiểu {passengers} chỗ trống ở ít nhất một hạng vé đang mở bán.
router.get('/search',async(req,res,next)=>{try{
  const {from,to,date,sort}=req.query;
  const passengers=Math.min(9,Math.max(1,parseInt(req.query.passengers,10)||1));
  if(from&&!/^[A-Za-z]{3}$/.test(from))return res.status(422).json({code:'VALIDATION',message:'Mã sân bay điểm đi không hợp lệ (3 ký tự IATA).'});
  if(to&&!/^[A-Za-z]{3}$/.test(to))return res.status(422).json({code:'VALIDATION',message:'Mã sân bay điểm đến không hợp lệ (3 ký tự IATA).'});
  if(from&&to&&from.toUpperCase()===to.toUpperCase())return res.status(422).json({code:'VALIDATION',message:'Điểm đi và điểm đến phải khác nhau.'});
  if(date&&isNaN(Date.parse(date)))return res.status(422).json({code:'VALIDATION',message:'Ngày bay không hợp lệ.'});
  const params=[];let where="f.status='OPEN_FOR_SALE'";
  if(from){params.push(from.toUpperCase());where+=` AND ao.iata_code=$${params.length}`}
  if(to){params.push(to.toUpperCase());where+=` AND ad.iata_code=$${params.length}`}
  if(date){params.push(date);where+=` AND (f.departure_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=$${params.length}::date`}
  else where+=" AND f.departure_time>=now()";
  params.push(passengers);const passParam=params.length;
  const orderBy=sort==='duration'?'duration ASC':sort==='departure'?'f.departure_time ASC':'price ASC NULLS LAST';
  const q=await db.query(`SELECT f.flight_id id,f.flight_no code,ao.iata_code "from",ao.city "fromCity",ao.name "fromAirport",ad.iata_code "to",ad.city "toCity",ad.name "toAirport",f.departure_time "departureTime",f.arrival_time "arrivalTime",to_char(f.departure_time AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI') depart,to_char(f.arrival_time AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI') arrive,round(extract(epoch from(f.arrival_time-f.departure_time))/60)::int duration,best.flight_fare_id "fareId",best.fare_class_id "fareClassId",coalesce(best.price,0)::float price,coalesce(best.name,'Eco') type,best.code "fareCode",best.conditions,coalesce(best.quota,0)::int "availableSeats"
    FROM flights f
    JOIN airports ao ON ao.airport_id=f.origin_id
    JOIN airports ad ON ad.airport_id=f.destination_id
    LEFT JOIN LATERAL(
      SELECT ff.flight_fare_id,ff.fare_class_id,ff.price,ff.quota,fc.name,fc.code,fc.conditions
      FROM flight_fares ff JOIN fare_classes fc USING(fare_class_id)
      WHERE ff.flight_id=f.flight_id AND ff.status='ACTIVE' AND fc.status='ACTIVE' AND ff.quota>=$${passParam}
      ORDER BY ff.price LIMIT 1
    )best ON true
    WHERE ${where} AND EXISTS(
      SELECT 1 FROM flight_fares ff2 JOIN fare_classes fc2 ON fc2.fare_class_id=ff2.fare_class_id WHERE ff2.flight_id=f.flight_id AND ff2.status='ACTIVE' AND fc2.status='ACTIVE' AND ff2.quota>=$${passParam}
    )
    ORDER BY ${orderBy} LIMIT 100`,params);
  res.json({items:q.rows,total:q.rowCount,query:{from:from?from.toUpperCase():null,to:to?to.toUpperCase():null,date:date||null,passengers}})
}catch(e){next(e)}});

// GET /api/v1/flights/:id - chi tiết một chuyến bay kèm toàn bộ hạng vé đang mở bán
router.get('/:id',async(req,res,next)=>{try{
  const f=(await db.query(`SELECT f.flight_id id,f.flight_no code,f.status,f.departure_time "departureTime",f.arrival_time "arrivalTime",ao.iata_code "from",ao.name "fromAirport",ao.city "fromCity",ad.iata_code "to",ad.name "toAirport",ad.city "toCity",ac.model aircraft,round(extract(epoch from(f.arrival_time-f.departure_time))/60)::int duration
    FROM flights f
    JOIN airports ao ON ao.airport_id=f.origin_id
    JOIN airports ad ON ad.airport_id=f.destination_id
    LEFT JOIN aircraft ac USING(aircraft_id)
    WHERE f.flight_id=$1`,[req.params.id])).rows[0];
  if(!f)return res.status(404).json({code:'FLIGHT_NOT_FOUND',message:'Không tìm thấy chuyến bay.'});
  const fares=await db.query(`SELECT ff.flight_fare_id id,fc.code,fc.name,ff.price::float,ff.currency,ff.quota "availableSeats" FROM flight_fares ff JOIN fare_classes fc USING(fare_class_id) WHERE ff.flight_id=$1 AND ff.status='ACTIVE' AND fc.status='ACTIVE' ORDER BY ff.price`,[req.params.id]);
  res.json({...f,fares:fares.rows})
}catch(e){next(e)}});

// GET /api/v1/flights/:id/fares - giữ endpoint cũ để tương thích ngược
// GET /api/v1/flights/:id/seats - danh sách ghế đã bị giữ/đã bán của một chuyến (công khai, giống trang chọn ghế của hãng bay).
// Ghế của vé đã hủy / hết hạn giữ chỗ được nhả tự động trước khi trả kết quả.
router.get('/:id/seats',auth(false),async(req,res,next)=>{try{
  const id=req.params.id;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return res.status(404).json({code:'FLIGHT_NOT_FOUND',message:'Không tìm thấy chuyến bay.'});
  const f=await db.query('SELECT 1 FROM flights WHERE flight_id=$1',[id]);
  if(!f.rows[0])return res.status(404).json({code:'FLIGHT_NOT_FOUND',message:'Không tìm thấy chuyến bay.'});
  await releaseStale(db,id,null,null);
  // Nếu gọi kèm token đăng nhập: ghế đang GIỮ DỞ (chờ thanh toán) của chính khách này tách riêng vào `mine` - khách vẫn chọn lại được
  // (vd. thanh toán VNPAY thất bại rồi quay lại), không bị báo nhầm là "người khác đã đặt". Mọi ghế còn lại nằm trong `taken`.
  const q=await db.query("SELECT bs.seat_code code,coalesce(b.user_id=$2::uuid AND b.status='PENDING_PAYMENT',false) mine FROM booking_seats bs JOIN bookings b ON b.booking_id=bs.booking_id WHERE bs.flight_id=$1 AND bs.status='ACTIVE' ORDER BY bs.seat_code",[id,req.user?.sub||null]);
  res.set('Cache-Control','no-store');
  res.json({flightId:id,taken:q.rows.filter(r=>!r.mine).map(r=>r.code),mine:q.rows.filter(r=>r.mine).map(r=>r.code)})
}catch(e){next(e)}});

router.get('/:id/fares',async(req,res,next)=>{try{const q=await db.query('SELECT ff.flight_fare_id id,fc.code,fc.name,ff.price::float,ff.currency,ff.quota FROM flight_fares ff JOIN fare_classes fc USING(fare_class_id) WHERE ff.flight_id=$1 AND ff.status=\'ACTIVE\'',[req.params.id]);res.json({items:q.rows})}catch(e){next(e)}});

module.exports=router;
