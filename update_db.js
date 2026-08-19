const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'equalizador',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
});

async function run() {
  try {
    const res = await pool.query("UPDATE maquinas SET tenancy = 'MVCLIENTESAAS' WHERE codigo = '1975' AND tenancy = 'CLOUDMVORACLE' RETURNING hostname, tenancy");
    console.log('Atualizado ' + res.rowCount + ' maquinas para MVCLIENTESAAS');
    res.rows.forEach(r => console.log(r.hostname, '->', r.tenancy));
  } catch(e) {
    console.error('Erro:', e.message);
  } finally {
    pool.end();
  }
}
run();
