const { Client } = require('ssh2');

async function testJump(jumpHost, jumpUser, jumpPass, targetHost, targetUser, targetPass) {
  return new Promise((resolve) => {
    const jumpClient = new Client();
    jumpClient.on('ready', () => {
      console.log(`✅ Conectado no BAL: ${jumpHost}`);
      jumpClient.forwardOut('127.0.0.1', 12345, targetHost, 22, (err, stream) => {
        if (err) {
          console.log(`❌ Erro no forwardOut para ${targetHost}: ${err.message}`);
          jumpClient.end();
          return resolve(false);
        }
        console.log(`✅ Túnel criado para ${targetHost}`);
        const targetClient = new Client();
        targetClient.on('ready', () => {
          console.log(`✅ Conectado no alvo: ${targetHost}`);
          targetClient.end();
          jumpClient.end();
          resolve(true);
        }).on('error', (err) => {
          console.log(`❌ Erro conectando no alvo ${targetHost}: ${err.message}`);
          jumpClient.end();
          resolve(false);
        }).connect({
          sock: stream,
          username: targetUser,
          password: targetPass,
          readyTimeout: 15000
        });
      });
    }).on('error', (err) => {
      console.log(`❌ Erro conectando no BAL ${jumpHost}: ${err.message}`);
      resolve(false);
    }).connect({
      host: jumpHost,
      port: 22,
      username: jumpUser,
      password: jumpPass,
      readyTimeout: 10000
    });
  });
}

(async () => {
  const jumpIp = '152.67.37.82';
  const jumpPass = 'MvMv@@20192019'; // the one that worked
  
  console.log("Testando 10.22.1.4...");
  await testJump(jumpIp, 'mv-portal', jumpPass, '10.22.1.4', 'mv-portal', jumpPass);
  
  console.log("Testando 10.22.1.17...");
  await testJump(jumpIp, 'mv-portal', jumpPass, '10.22.1.17', 'mv-portal', jumpPass);
})();
