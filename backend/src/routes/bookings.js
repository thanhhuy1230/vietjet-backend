const router=require('express').Router();const db=require('../db');const {auth}=require('../middleware/auth');const crypto=require('crypto');const {describeSeat,releaseStale,takenAmong,releaseForBooking}=require('../utils/seats');const {confirmBooking,restoreInventory}=require('../utils/bookingState');const loyalty=require('../utils/loyalty');
// Mã đặt chỗ (PNR) 6 ký tự chỉ gồm chữ in hoa và số; bỏ I, O, 0, 1 để khách không đọc nhầm.
// Bảng 32 ký tự nên mỗi byte ngẫu nhiên chia lấy dư 32 cho phân bố đều.
const PNR_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pnr=()=>Array.from(crypto.randomBytes(6),b=>PNR_CHARS[b%PNR_CHARS.length]).join('');

// Nạp chi tiết đầy đủ 1 booking: thông tin vé, các chặng bay, hành khách, lịch sử thanh toán.
async function loadDetail(bookingId){
  const b=(await db.query('SELECT booking_id id,pnr,status,total_amount::float "totalAmount",currency,expires_at "expiresAt",confirmed_at "confirmedAt",created_at "createdAt",updated_at "updatedAt",user_id "userId" FROM bookings WHERE booking_id=$1',[bookingId])).rows[0];
  if(!b)return null;
  const segments=await db.query(`SELECT bs.segment_id id,bs.subtotal::float,f.flight_id "flightId",f.flight_no "flightNo",f.status "flightStatus",ao.iata_code "from",ao.city "fromCity",ad.iata_code "to",ad.city "toCity",f.departure_time "departureTime",f.arrival_time "arrivalTime",fc.code "fareClassCode",fc.name "fareClassName"
    FROM booking_segments bs
    JOIN flights f ON f.flight_id=bs.flight_id
    JOIN airports ao ON ao.airport_id=f.origin_id
    JOIN airports ad ON ad.airport_id=f.destination_id
    JOIN fare_classes fc ON fc.fare_class_id=bs.fare_class_id
    WHERE bs.booking_id=$1 ORDER BY f.departure_time`,[bookingId]);
  const passengers=await db.query('SELECT passenger_id id,full_name "fullName",dob,nationality FROM passengers WHERE booking_id=$1 ORDER BY full_name',[bookingId]);
  const payments=await db.query('SELECT payment_id id,provider,amount::float,refunded_amount::float "refundedAmount",status,created_at "createdAt" FROM payments WHERE booking_id=$1 ORDER BY created_at DESC',[bookingId]);
  const refunds=await db.query('SELECT refund_id id,amount::float,fee::float,status,requested_at "requestedAt" FROM refund_requests WHERE booking_id=$1 ORDER BY requested_at DESC',[bookingId]);
  const sj=(await db.query(`SELECT b.points_redeemed "pointsRedeemed", b.points_discount::float "pointsDiscount",
      (SELECT json_build_object('points',t.points,'status',t.status,'availableAt',t.available_at) FROM loyalty_transactions t WHERE t.booking_id=b.booking_id AND t.type='EARN' LIMIT 1) earn
    FROM bookings b WHERE b.booking_id=$1`,[bookingId])).rows[0]||{};
  const seats=await db.query("SELECT bs.segment_id \"segmentId\",bs.flight_id \"flightId\",bs.passenger_id \"passengerId\",bs.seat_code code,bs.seat_type type,bs.price::float price FROM booking_seats bs WHERE bs.booking_id=$1 AND bs.status='ACTIVE' ORDER BY bs.seat_code",[bookingId]);
  const services=await db.query('SELECT bsv.segment_id "segmentId",bsv.passenger_id "passengerId",s.code,s.name,s.type,bsv.qty,bsv.unit_price::float "unitPrice" FROM booking_services bsv JOIN booking_segments bs ON bs.segment_id=bsv.segment_id JOIN ancillary_services s ON s.service_id=bsv.service_id WHERE bs.booking_id=$1 ORDER BY s.type,s.code',[bookingId]);
  const tickets=await db.query('SELECT t.ticket_id id,t.ticket_no "ticketNo",t.segment_id "segmentId",t.passenger_id "passengerId",t.status FROM tickets t JOIN booking_segments bs ON bs.segment_id=t.segment_id WHERE bs.booking_id=$1 ORDER BY t.issued_at',[bookingId]);
  return {...b,segments:segments.rows,passengers:passengers.rows,payments:payments.rows,refunds:refunds.rows,seats:seats.rows,services:services.rows,tickets:tickets.rows,skyjoy:sj};
}

// POST /api/v1/bookings - đặt vé (YÊU CẦU ĐĂNG NHẬP). Hỗ trợ 1 chặng, khứ hồi và nhiều chặng:
//   { segments:[{flightId,fareClassId},...], passengers:[...], promotionCode }   (nhiều chặng / khứ hồi)
//   { flightId, fareClassId, passengers:[...] }                                  (1 chặng - kiểu cũ vẫn dùng được)
// Chọn ghế (tùy chọn): mỗi chặng có thể kèm seats:['5A', ...] - ghế thứ i dành cho hành khách thứ i. Ghế được GIỮ ngay khi đặt vé
// (booking chờ thanh toán 15 phút) và khóa với người khác cho tới khi vé bị hủy / hết hạn giữ chỗ. Ghế đã có người giữ -> 409 SEAT_TAKEN.
// Tính tiền hoàn toàn ở SERVER (không tin số tiền app gửi lên):
//   tổng = giá vé các chặng × số khách + giá ghế đã chọn + dịch vụ bổ sung − khuyến mãi.
// Dịch vụ: services:[{serviceId}] - áp cho mọi hành khách; đơn vị 'Mỗi chặng' tính theo số chặng, còn lại tính 1 lần / khách.
const perSegment=unit=>/chặng/i.test(String(unit||''));
async function priceServices(c,services,segCount,paxCount){
  const ids=[...new Set((Array.isArray(services)?services:[]).map(x=>x&&(x.serviceId||x.id)).filter(Boolean))];
  if(!ids.length)return {items:[],total:0};
  const rows=(await c.query("SELECT service_id,code,name,unit,base_price::float price FROM ancillary_services WHERE service_id::text = ANY($1) AND status='ACTIVE'",[ids.map(String)])).rows;
  if(rows.length!==ids.length)throw Object.assign(new Error('Có dịch vụ bổ sung không còn được bán. Vui lòng chọn lại dịch vụ.'),{status:409,code:'SERVICE_UNAVAILABLE'});
  const items=rows.map(r=>({...r,qtyPerPax:perSegment(r.unit)?segCount:1}));
  return {items,total:items.reduce((t,x)=>t+x.price*x.qtyPerPax*paxCount,0)};
}
// Kiểm tra mã khuyến mãi (dùng chung cho đặt vé và /promotions/validate). Ném lỗi 422 nếu không hợp lệ.
async function checkPromotion(c,code,subtotal,userId,lock=false){
  const p=(await c.query(`SELECT * FROM promotions WHERE upper(code)=upper($1) AND status='ACTIVE' AND now() BETWEEN starts_at AND ends_at${lock?' FOR UPDATE':''}`,[code])).rows[0];
  if(!p)throw Object.assign(new Error('Mã khuyến mãi không hợp lệ hoặc đã hết hạn.'),{status:422,code:'PROMOTION_INVALID'});
  if(subtotal<+p.min_order)throw Object.assign(new Error(`Mã ${p.code} áp dụng cho đơn từ ${Number(p.min_order).toLocaleString('vi-VN')} ₫.`),{status:422,code:'MIN_ORDER'});
  const used=(await c.query("SELECT count(*)::int n, count(*) FILTER (WHERE u.user_id=$2)::int mine FROM promotion_usages u JOIN bookings b ON b.booking_id=u.booking_id WHERE u.promotion_id=$1 AND b.status<>'CANCELLED'",[p.promotion_id,userId||null])).rows[0];
  if(p.usage_limit&&used.n>=p.usage_limit)throw Object.assign(new Error('Mã khuyến mãi đã hết lượt sử dụng.'),{status:422,code:'PROMOTION_EXHAUSTED'});
  if(userId&&p.per_user_limit&&used.mine>=p.per_user_limit)throw Object.assign(new Error('Bạn đã dùng hết số lần cho phép của mã này.'),{status:422,code:'PROMOTION_USER_LIMIT'});
  let discount=p.discount_type==='PERCENT'?subtotal*(+p.discount_value)/100:+p.discount_value;
  if(p.max_discount)discount=Math.min(discount,+p.max_discount);
  discount=Math.round(Math.min(discount,subtotal));
  return {promo:p,discount};
}

// POST /api/v1/bookings - đặt vé (YÊU CẦU ĐĂNG NHẬP). Hỗ trợ 1 chặng, khứ hồi và nhiều chặng:
//   { segments:[{flightId,fareClassId,seats:['5A']},...], passengers:[...], services:[{serviceId}], promotionCode }
//   { flightId, fareClassId, passengers:[...] }   (1 chặng - kiểu cũ vẫn dùng được)
// Ghế được GIỮ ngay khi đặt vé (booking chờ thanh toán 15 phút); ghế đã có người giữ -> 409 SEAT_TAKEN.
router.post('/',auth(),async(req,res,next)=>{try{
  const {passengers=[],promotionCode,services=[]}=req.body||{};
  let segs=Array.isArray(req.body.segments)&&req.body.segments.length?req.body.segments:(req.body.flightId?[{flightId:req.body.flightId,fareClassId:req.body.fareClassId}]:[]);
  if(!segs.length||segs.some(x=>!x||!x.flightId||!x.fareClassId)||!passengers.length)return res.status(422).json({code:'VALIDATION',message:'Chuyến bay, hạng vé và hành khách là bắt buộc.'});
  if(passengers.some(p=>!p||!String(p.fullName||'').trim()))return res.status(422).json({code:'VALIDATION',message:'Vui lòng nhập họ tên hành khách.'});
  if(segs.length>6)return res.status(422).json({code:'VALIDATION',message:'Tối đa 6 chặng bay cho mỗi lần đặt.'});
  if(passengers.length>9)return res.status(422).json({code:'VALIDATION',message:'Tối đa 9 hành khách cho mỗi lần đặt.'});
  if(new Set(segs.map(x=>x.flightId)).size!==segs.length)return res.status(422).json({code:'VALIDATION',message:'Không thể chọn trùng một chuyến bay trong cùng một lần đặt.'});
  const seatCodes=segs.map(sg=>(Array.isArray(sg.seats)?sg.seats:[]).map(x=>x==null?'':String(x).trim().toUpperCase()));
  for(const codes of seatCodes){
    if(codes.length>passengers.length)return res.status(422).json({code:'VALIDATION',message:'Số ghế chọn nhiều hơn số hành khách.'});
    const filled=codes.filter(Boolean);
    if(new Set(filled).size!==filled.length)return res.status(422).json({code:'VALIDATION',message:'Không thể chọn trùng một ghế cho nhiều hành khách.'});
  }
  const booking=await db.tx(async c=>{
    const priced=[];let prevArrival=null;let seatTotal=0;
    for(const [idx,sg] of segs.entries()){
      const fare=(await c.query("SELECT ff.price,ff.quota,fc.code fare_code,f.status flight_status,f.departure_time,f.arrival_time FROM flight_fares ff JOIN flights f ON f.flight_id=ff.flight_id JOIN fare_classes fc ON fc.fare_class_id=ff.fare_class_id WHERE ff.flight_id=$1 AND ff.fare_class_id=$2 AND ff.status='ACTIVE' FOR UPDATE OF ff",[sg.flightId,sg.fareClassId])).rows[0];
      if(!fare)throw Object.assign(new Error('Hạng vé không còn mở bán.'),{status:409,code:'FARE_UNAVAILABLE'});
      if(fare.flight_status!=='OPEN_FOR_SALE'||new Date(fare.departure_time)<=new Date())throw Object.assign(new Error('Chuyến bay đã đóng bán hoặc đã khởi hành.'),{status:409,code:'FLIGHT_CLOSED'});
      if(+fare.quota<passengers.length)throw Object.assign(new Error('Không đủ chỗ trống cho số hành khách đã chọn.'),{status:409,code:'NOT_ENOUGH_SEATS'});
      if(prevArrival&&new Date(fare.departure_time)<prevArrival)throw Object.assign(new Error('Các chặng bay phải theo đúng thứ tự thời gian (chặng sau khởi hành sau khi chặng trước đã đến).'),{status:422,code:'SEGMENT_ORDER'});
      prevArrival=new Date(fare.arrival_time);
      const wanted=seatCodes[idx].filter(Boolean);
      for(const code of wanted){const info=describeSeat(code,fare.fare_code);if(!info)throw Object.assign(new Error(`Ghế ${code} không hợp lệ với hạng vé của chuyến này.`),{status:422,code:'INVALID_SEAT'});seatTotal+=info.price}
      if(wanted.length){
        await releaseStale(c,sg.flightId,wanted,req.user.sub);
        const taken=await takenAmong(c,sg.flightId,wanted);
        if(taken.length)throw Object.assign(new Error(`Ghế ${taken.join(', ')} vừa được người khác đặt. Vui lòng chọn ghế khác.`),{status:409,code:'SEAT_TAKEN',seats:taken.map(code=>({flightId:sg.flightId,code}))});
      }
      priced.push({...sg,subtotal:+fare.price*passengers.length,fareCode:fare.fare_code});
    }
    const svc=await priceServices(c,services,priced.length,passengers.length);
    const gross=priced.reduce((t,x)=>t+x.subtotal,0)+seatTotal+svc.total;
    let total=gross,promo=null;
    if(promotionCode&&String(promotionCode).trim()){const r=await checkPromotion(c,String(promotionCode).trim(),gross,req.user.sub,true);promo=r.promo;total=gross-r.discount}
    // SkyJoy (tùy chọn): dùng điểm giảm thêm SAU khuyến mãi. Không gửi redeemPoints -> như cũ.
    const afterPromo=total;
    const redeem=await loyalty.quoteRedeem(c,req.user.sub,req.body.redeemPoints,afterPromo);
    total=afterPromo-redeem.discount;
    const b=(await c.query("INSERT INTO bookings(pnr,user_id,status,total_amount,expires_at,points_redeemed,points_discount) VALUES($1,$2,'PENDING_PAYMENT',$3,now()+interval '15 minutes',$4,$5) RETURNING *",[pnr(),req.user.sub,total,redeem.points,redeem.discount])).rows[0];
    await loyalty.holdRedeem(c,req.user.sub,b.booking_id,redeem.points,b.pnr);
    const segmentIds=[];
    for(const x of priced){segmentIds.push((await c.query('INSERT INTO booking_segments(booking_id,flight_id,fare_class_id,subtotal) VALUES($1,$2,$3,$4) RETURNING segment_id',[b.booking_id,x.flightId,x.fareClassId,x.subtotal])).rows[0].segment_id)}
    const passengerIds=[];
    for(const p of passengers)passengerIds.push((await c.query('INSERT INTO passengers(booking_id,full_name,dob,nationality) VALUES($1,$2,$3,$4) RETURNING passenger_id',[b.booking_id,String(p.fullName).trim(),p.dob||null,p.nationality||'VN'])).rows[0].passenger_id);
    for(const [i,x] of priced.entries()){
      for(const [pi,code] of seatCodes[i].entries()){
        if(!code)continue;
        const info=describeSeat(code,x.fareCode); // loại ghế + giá do SERVER quyết định, không tin dữ liệu app gửi
        await c.query('INSERT INTO booking_seats(booking_id,segment_id,passenger_id,flight_id,seat_code,seat_type,price) VALUES($1,$2,$3,$4,$5,$6,$7)',[b.booking_id,segmentIds[i],passengerIds[pi],x.flightId,info.code,info.type,info.price]);
      }
    }
    for(const sv of svc.items){
      const segList=perSegment(sv.unit)?segmentIds:[segmentIds[0]];
      for(const segId of segList)for(const pid of passengerIds)await c.query('INSERT INTO booking_services(segment_id,passenger_id,service_id,qty,unit_price) VALUES($1,$2,$3,1,$4)',[segId,pid,sv.service_id,sv.price]);
    }
    if(promo)await c.query('INSERT INTO promotion_usages(promotion_id,booking_id,user_id,discount_amount) VALUES($1,$2,$3,$4)',[promo.promotion_id,b.booking_id,req.user.sub,gross-afterPromo]);
    return {...b,total_amount:+b.total_amount,totalAmount:+b.total_amount,grossAmount:gross,discount:gross-afterPromo,pointsRedeemed:redeem.points,pointsDiscount:redeem.discount,seatAmount:seatTotal,serviceAmount:svc.total,segmentId:segmentIds[0],segmentIds}
  });
  res.status(201).json(booking)
}catch(e){
  if(e.code==='SEAT_TAKEN')return res.status(409).json({code:'SEAT_TAKEN',message:e.message,seats:e.seats||[]});
  // 2 người bấm đặt cùng một ghế cùng lúc: chỉ mục duy nhất của DB chỉ cho 1 người thắng, người còn lại rơi vào đây.
  if(e.code==='23505'&&e.constraint==='uq_booking_seat_active')return res.status(409).json({code:'SEAT_TAKEN',message:'Có ghế vừa được người khác đặt. Vui lòng chọn ghế khác.',seats:[]});
  next(e)
}});

// GET /api/v1/bookings/mine?status=CONFIRMED - lịch sử đặt vé của người dùng đang đăng nhập, kèm thông tin chặng bay
router.get('/mine',auth(),async(req,res,next)=>{try{
  const params=[req.user.sub];let where='b.user_id=$1';
  if(req.query.status){params.push(req.query.status.toUpperCase());where+=` AND b.status=$${params.length}`}
  const q=await db.query(`SELECT b.booking_id id,b.pnr,b.status,b.total_amount::float "totalAmount",b.currency,b.expires_at "expiresAt",b.confirmed_at "confirmedAt",b.created_at "createdAt",
      coalesce(seg.segments,'[]') segments,coalesce(pax.count,0)::int "passengerCount"
    FROM bookings b
    LEFT JOIN LATERAL(
      SELECT json_agg(json_build_object('segmentId',bs.segment_id,'flightId',f.flight_id,'flightNo',f.flight_no,'from',ao.iata_code,'to',ad.iata_code,'departureTime',f.departure_time,'arrivalTime',f.arrival_time,'fareClass',fc.name) ORDER BY f.departure_time) segments
      FROM booking_segments bs JOIN flights f ON f.flight_id=bs.flight_id JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id JOIN fare_classes fc ON fc.fare_class_id=bs.fare_class_id
      WHERE bs.booking_id=b.booking_id
    )seg ON true
    LEFT JOIN LATERAL(SELECT count(*) FROM passengers p WHERE p.booking_id=b.booking_id)pax ON true
    WHERE ${where} ORDER BY b.created_at DESC`,params);
  res.json({items:q.rows})
}catch(e){next(e)}});

// GET /api/v1/bookings/lookup?pnr=ABC123&email=... - tra cứu vé công khai (không cần đăng nhập) bằng mã đặt chỗ + email đặt vé
router.get('/lookup',async(req,res,next)=>{try{
  const {pnr:code,email}=req.query;
  if(!code||!email)return res.status(422).json({code:'VALIDATION',message:'Vui lòng nhập mã đặt chỗ (PNR) và email đã dùng để đặt vé.'});
  const b=(await db.query('SELECT b.booking_id FROM bookings b JOIN users u ON u.user_id=b.user_id WHERE upper(b.pnr)=upper($1) AND lower(u.email)=lower($2)',[code,email])).rows[0];
  if(!b)return res.status(404).json({code:'BOOKING_NOT_FOUND',message:'Không tìm thấy vé phù hợp. Vui lòng kiểm tra lại mã đặt chỗ và email.'});
  const detail=await loadDetail(b.booking_id);delete detail.userId;
  res.json(detail)
}catch(e){next(e)}});

// Tra cuu theo PNR nam trong path (giu lai cho app mobile native: GET /bookings/lookup/:pnr?email=...). Web dung /lookup?pnr=&email=.
router.get('/lookup/:pnr',async(req,res,next)=>{try{const {pnr}=req.params;const email=String(req.query.email||'').trim().toLowerCase();if(!email)return res.status(422).json({code:'VALIDATION',message:'Cần nhập email để tra cứu.'});const bq=await db.query(`SELECT b.booking_id id,b.pnr,b.status,b.total_amount::float "totalAmount",b.currency,b.created_at "createdAt" FROM bookings b JOIN users u ON u.user_id=b.user_id WHERE upper(b.pnr)=upper($1) AND lower(u.email)=$2`,[pnr,email]);const b=bq.rows[0];if(!b)return res.status(404).json({code:'NOT_FOUND',message:'Không tìm thấy booking phù hợp với mã và email đã nhập.'});const segs=await db.query(`SELECT f.flight_no "flightCode",ao.iata_code "originCode",ad.iata_code "destinationCode",f.departure_time "departureTime",f.arrival_time "arrivalTime",fc.name "fareClassName",bs.subtotal::float "farePrice" FROM booking_segments bs JOIN flights f ON f.flight_id=bs.flight_id JOIN airports ao ON ao.airport_id=f.origin_id JOIN airports ad ON ad.airport_id=f.destination_id JOIN fare_classes fc ON fc.fare_class_id=bs.fare_class_id WHERE bs.booking_id=$1 ORDER BY f.departure_time`,[b.id]);const pax=await db.query('SELECT full_name "fullName",dob FROM passengers WHERE booking_id=$1',[b.id]);res.json({...b,segments:segs.rows,passengers:pax.rows})}catch(e){next(e)}});

// GET /api/v1/bookings/:id - xem chi tiết một vé của chính người dùng đang đăng nhập
router.get('/:id',auth(),async(req,res,next)=>{try{
  const detail=await loadDetail(req.params.id);
  if(!detail||detail.userId!==req.user.sub)return res.status(404).json({code:'BOOKING_NOT_FOUND',message:'Không tìm thấy booking.'});
  delete detail.userId;
  res.json(detail)
}catch(e){next(e)}});

router.post('/:id/payments',auth(),async(req,res,next)=>{try{if(process.env.ALLOW_DEMO_PAYMENT==='false')return res.status(403).json({code:'DEMO_PAYMENT_DISABLED',message:'Thanh toán thử đã bị tắt, vui lòng thanh toán qua VNPAY.'});const key=req.headers['idempotency-key'];if(!key)return res.status(422).json({code:'IDEMPOTENCY_REQUIRED',message:'Thiếu Idempotency-Key.'});const out=await db.tx(async c=>{const b=(await c.query('SELECT * FROM bookings WHERE booking_id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.user.sub])).rows[0];if(!b)throw Object.assign(new Error('Không tìm thấy booking.'),{status:404});let p=(await c.query('SELECT * FROM payments WHERE idempotency_key=$1',[key])).rows[0];if(p)return p;p=(await c.query("INSERT INTO payments(booking_id,provider,amount,status,idempotency_key) VALUES($1,$2,$3,'SUCCEEDED',$4) RETURNING *",[b.booking_id,'DEMO',b.total_amount,key])).rows[0];if(b.status!=='PENDING_PAYMENT')throw Object.assign(new Error('Booking không ở trạng thái chờ thanh toán.'),{status:409,code:'BOOKING_NOT_PAYABLE'});if(b.expires_at&&new Date(b.expires_at)<=new Date())throw Object.assign(new Error('Booking đã hết thời gian giữ chỗ, vui lòng đặt lại.'),{status:409,code:'BOOKING_EXPIRED'});await confirmBooking(c,b.booking_id);await c.query("INSERT INTO notifications(user_id,booking_id,type,title,body,status,sent_at) VALUES($1,$2,'BOOKING_CONFIRMED','Đặt vé thành công',$3,'SENT',now())",[req.user.sub,b.booking_id,`Booking ${b.pnr} đã được xác nhận.`]);return p});res.json(out)}catch(e){next(e)}});

// POST /api/v1/bookings/:id/cancel - hủy vé của chính người dùng đang đăng nhập
// Chỉ cho hủy khi booking đang PENDING_PAYMENT hoặc CONFIRMED và chưa tới giờ khởi hành của chặng sớm nhất.
// Nếu đã thanh toán thành công thì tự tạo yêu cầu hoàn tiền (refund_requests) để bộ phận vận hành xử lý.
router.post('/:id/cancel',auth(),async(req,res,next)=>{try{
  const result=await db.tx(async c=>{
    const b=(await c.query('SELECT * FROM bookings WHERE booking_id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.user.sub])).rows[0];
    if(!b)throw Object.assign(new Error('Không tìm thấy booking.'),{status:404});
    if(!['PENDING_PAYMENT','CONFIRMED'].includes(b.status))throw Object.assign(new Error('Vé đã hủy hoặc không ở trạng thái có thể hủy.'),{status:409,code:'CANCEL_NOT_ALLOWED'});
    const earliest=(await c.query('SELECT min(f.departure_time) departs FROM booking_segments bs JOIN flights f USING(flight_id) WHERE bs.booking_id=$1',[b.booking_id])).rows[0];
    if(earliest.departs&&new Date(earliest.departs)<=new Date())throw Object.assign(new Error('Không thể hủy vé sau giờ khởi hành.'),{status:409,code:'FLIGHT_DEPARTED'});
    // Vé đã thanh toán (CONFIRMED) chỉ được hủy khi còn >= CANCEL_MIN_DAYS ngày trước giờ bay (khớp quy tắc hiển thị trên web/mobile). Vé chưa thanh toán thì hủy bất cứ lúc nào.
    const minDays=Number(process.env.CANCEL_MIN_DAYS??2);
    if(b.status==='CONFIRMED'&&earliest.departs&&minDays>0&&(new Date(earliest.departs)-new Date())<minDays*86400000)throw Object.assign(new Error(`Đã quá hạn hủy vé: chỉ hủy được khi còn ít nhất ${minDays} ngày trước giờ khởi hành.`),{status:409,code:'CANCEL_WINDOW_PASSED'});
    await c.query("UPDATE bookings SET status='CANCELLED',updated_at=now() WHERE booking_id=$1",[b.booking_id]);
    await loyalty.onBookingCancelled(c,b); // SkyJoy: trả / hoàn điểm, hủy điểm chờ cộng
    if(b.status==='CONFIRMED')await restoreInventory(c,b.booking_id); // trả lại chỗ cho chuyến bay
    await releaseForBooking(c,b.booking_id); // nhả ghế để người khác đặt được
    await c.query("UPDATE tickets SET status='CANCELLED',updated_at=now() WHERE segment_id IN(SELECT segment_id FROM booking_segments WHERE booking_id=$1) AND status NOT IN('CANCELLED','FLOWN')",[b.booking_id]);
    const payment=(await c.query("SELECT * FROM payments WHERE booking_id=$1 AND status='SUCCEEDED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[b.booking_id])).rows[0];
    let refund=null;
    if(payment){refund=(await c.query("INSERT INTO refund_requests(booking_id,payment_id,amount,fee,status) VALUES($1,$2,$3,0,'REQUESTED') RETURNING refund_id id,amount::float,fee::float,status,requested_at \"requestedAt\"",[b.booking_id,payment.payment_id,payment.amount])).rows[0]}
    await c.query("INSERT INTO notifications(user_id,booking_id,type,title,body,status,sent_at) VALUES($1,$2,'BOOKING_CANCELLED','Vé đã được hủy',$3,'SENT',now())",[req.user.sub,b.booking_id,`Booking ${b.pnr} đã được hủy theo yêu cầu của bạn.${refund?' Yêu cầu hoàn tiền đang được xử lý.':''}`]);
    return {bookingId:b.booking_id,pnr:b.pnr,status:'CANCELLED',refund};
  });
  res.json(result)
}catch(e){next(e)}});

module.exports=router;module.exports.checkPromotion=checkPromotion;module.exports.priceServices=priceServices;
