const { Client } = require('ssh2');

const testConn = (host, username, password) => {
  return new Promise((resolve) => {
    const conn = new Client();
    conn.on('ready', () => {
      console.log(`✅ Conectado com sucesso em ${host} usando a senha ${password}`);
      conn.end();
      resolve(true);
    }).on('error', (err) => {
      console.log(`❌ Erro conectando em ${host} com a senha ${password}: ${err.message}`);
      resolve(false);
    }).connect({
      host,
      port: 22,
      username,
      password,
      readyTimeout: 10000
    });
  });
};

(async () => {
  const host = '152.67.37.82';
  const user = 'mv-portal';
  
  await testConn(host, user, 'MvMv@@2019-9102'); // MVCLIENTESAAS
  await testConn(host, user, 'MvMv@@20192019');  // CLOUDMVORACLE
  
  const host2 = '144.22.236.240';
  await testConn(host2, user, 'MvMv@@2019-9102');
  await testConn(host2, user, 'MvMv@@20192019');
})();
