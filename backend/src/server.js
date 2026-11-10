const app=require('./app');const {pool}=require('./db');const port=Number(process.env.PORT||3000);const server=app.listen(port,()=>{
  console.log(`Vietjet API: http://localhost:${port}/api/v1/health`);
  // In địa chỉ LAN để kiểm tra từ điện thoại (Expo Go phải cùng Wi-Fi với máy này)
  const nets=require('os').networkInterfaces();
  for(const [name,list] of Object.entries(nets))for(const n of list||[])if(n.family==='IPv4'&&!n.internal)console.log(`  Mạng ${name}: http://${n.address}:${port}/api/v1/health`);
});
async function shutdown(){server.close(async()=>{await pool.end();process.exit(0)})}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
