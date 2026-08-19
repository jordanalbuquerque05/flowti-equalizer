const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
});

async function run() {
  try {
    const res = await pool.query(\"SELECT * FROM maquinas WHERE codigo = '1975' AND hostname ILIKE '%bal%'\");
    console.log('BALs no Banco:');
    res.rows.forEach(r => console.log(r.hostname, '| IP:', r.ip, '| PubIP:', r.public_ip, '| Tenancy:', r.tenancy));
    
    const res2 = await pool.query(\"SELECT * FROM maquinas WHERE codigo = '1975' AND hostname ILIKE '%prd2%soul%'\");
    console.log('\nSOULs PRD2 no Banco:');
    res2.rows.forEach(r => console.log(r.hostname, '| IP:', r.ip, '| Tenancy:', r.tenancy));
  } catch(e) {
    console.error('Erro:', e.message);
  } finally {
    pool.end();
  }
}
run();
