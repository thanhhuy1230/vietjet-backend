const jwt=require('jsonwebtoken');
function auth(required=true){return(req,res,next)=>{const raw=req.headers.authorization||'';const token=raw.startsWith('Bearer ')?raw.slice(7):null;if(!token){if(required)return res.status(401).json({code:'UNAUTHORIZED',message:'Bạn cần đăng nhập.'});return next()}try{req.user=jwt.verify(token,process.env.JWT_SECRET);next()}catch{return res.status(401).json({code:'INVALID_TOKEN',message:'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.'})}}}
function allow(...roles){return(req,res,next)=>req.user&&roles.includes(req.user.role)?next():res.status(403).json({code:'FORBIDDEN',message:'Bạn không có quyền thực hiện thao tác này.'})}
module.exports={auth,allow};
