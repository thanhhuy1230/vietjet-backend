function notFound(req,res){res.status(404).json({code:'NOT_FOUND',message:'Không tìm thấy tài nguyên.'})}
function errorHandler(err,req,res,next){console.error(err);if(err.code==='23505')return res.status(409).json({code:'DUPLICATE',message:'Dữ liệu đã tồn tại.',details:err.detail});if(err.code==='23503')return res.status(409).json({code:'REFERENCE_CONFLICT',message:'Dữ liệu đang được tham chiếu.'});const status=err.status||400;res.status(status).json({code:err.code||'BAD_REQUEST',message:err.message||'Yêu cầu không hợp lệ.'})}
module.exports={notFound,errorHandler};
