const { Client } = require('ssh2');

async function testJump(jumpHost, jumpUser, jumpPass, targetHost, targetUser, targetPass) {
  return new Promise((resolve) => {
    const jumpClient = new Client();
    jumpClient.on('ready', () => {
      console.log(`✅ Conectado no BAL: ${jumpHost}`);
      if (!targetHost) { jumpClient.end(); return resolve(true); }
      
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
  const jump1 = '140.238.189.164';
  const jump2 = '137.131.175.115';
  
  const passwords = ['MvMv@@2019-9102', 'MvMv@@20192019', 'MvMv@@2019'];

  for (const pass of passwords) {
    console.log(`Testando ${jump1} com senha ${pass}...`);
    const success1 = await testJump(jump1, 'mv-portal', pass);
    if (success1) {
       console.log(`>>> Senha correta para ${jump1} é ${pass}`);
       break;
    }
  }

  for (const pass of passwords) {
    console.log(`Testando ${jump2} com senha ${pass}...`);
    const success2 = await testJump(jump2, 'mv-portal', pass);
    if (success2) {
       console.log(`>>> Senha correta para ${jump2} é ${pass}`);
       break;
    }
  }
})();
