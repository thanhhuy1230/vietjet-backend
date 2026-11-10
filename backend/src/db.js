const {Pool}=require('pg');
const ssl=process.env.DB_SSL==='true'?{rejectUnauthorized:false}:false;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl,max:20,idleTimeoutMillis:30000});
pool.on('error',err=>console.error('PostgreSQL pool error',err));
async function tx(work){const client=await pool.connect();try{await client.query('BEGIN');const out=await work(client);await client.query('COMMIT');return out}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
module.exports={pool,query:(text,params)=>pool.query(text,params),tx};
