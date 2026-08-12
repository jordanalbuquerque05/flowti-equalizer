const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

const newHelpers = `
// ─── SSH Fallback & Prioritization Helpers ─────────────────────────────────────
function getIPMatchScore(ip1, ip2) {
  if (!ip1 || !ip2) return 0;
  const p1 = ip1.split('.');
  const p2 = ip2.split('.');
  let score = 0;
  for (let i = 0; i < 4; i++) {
    if (p1[i] === p2[i]) score++;
    else break;
  }
  return score;
}

function sortBalsBySubnet(bals, targetIp) {
  if (!bals || bals.length === 0) return [];
  return [...bals].sort((a, b) => {
    const scoreA = getIPMatchScore(a.ip, targetIp);
    const scoreB = getIPMatchScore(b.ip, targetIp);
    return scoreB - scoreA; // Descending
  });
}

function sshChainExecCore(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, isStream, onData, timeout = 35000) {
  return new Promise((resolve, reject) => {
    const Client = require('ssh2').Client;
    const jumpClient = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; jumpClient.end(); reject(new Error('Timeout na cadeia SSH')); }
    }, timeout);

    jumpClient.on('ready', () => {
      jumpClient.forwardOut('127.0.0.1', 0, soulPrivIp, 22, (err, stream) => {
        if (err) {
          clearTimeout(timer); jumpClient.end();
          if (!settled) { settled = true; reject(err); }
          return;
        }

        const soulClient = new Client();
        soulClient.on('ready', () => {
          let output = '';
          soulClient.exec(cmd, (err2, s) => {
            if (err2) {
              clearTimeout(timer); soulClient.end(); jumpClient.end();
              if (!settled) { settled = true; reject(err2); }
              return;
            }
            s.on('data', d => {
              const chunk = d.toString();
              if (isStream && onData) onData(chunk);
              else output += chunk;
            });
            s.stderr.on('data', () => { });
            s.on('close', () => {
              clearTimeout(timer); soulClient.end(); jumpClient.end();
              if (!settled) { settled = true; resolve(output); }
            });
          });
        });

        soulClient.on('error', err3 => {
          clearTimeout(timer); jumpClient.end();
          if (!settled) { settled = true; reject(err3); }
        });

        soulClient.connect({ sock: stream, username: process.env.SSH_USER || 'flowti', password: soulPwd, readyTimeout: 15000 });
      });
    });

    jumpClient.on('error', err4 => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err4); }
    });

    jumpClient.connect({ host: balPubIp, port: 22, username: process.env.SSH_USER || 'flowti', password: balPwd, readyTimeout: 15000 });
  });
}

async function executeWithBalFallback({ bals, balHost, balTenancy, targetMachine, cmd, isStream, onData, timeout, res }) {
  let availableBals = [];
  if (bals && bals.length > 0) {
    // Tenta usar apenas BALs que tenham IP publico preenchido
    availableBals = bals.filter(b => b.public_ip && b.public_ip !== '---');
  }

  // Se nao tiver na lista, monta um fallback mock usando o balHost recebido pela UI
  if (availableBals.length === 0) {
    availableBals = [{
      public_ip: balHost,
      ip: '0.0.0.0', // IP dummy
      tenancy: balTenancy
    }];
  }

  // Sort BALs por similaridade com o targetMachine.ip
  const sortedBals = sortBalsBySubnet(availableBals, targetMachine.ip);
  
  let lastErr = null;
  const soulPassword = targetMachine.sshPassword || targetMachine.senha || Object.values(require('./server.js').SSH_PASSWORDS || {})[0] || '';

  for (let i = 0; i < sortedBals.length; i++) {
    const b = sortedBals[i];
    const balPwd = b.sshPassword || b.senha || (b.tenancy ? (require('./server.js').SSH_PASSWORDS || {})[b.tenancy] : '') || Object.values(require('./server.js').SSH_PASSWORDS || {})[0];
    
    if (res && isStream) {
      if (i > 0) {
        res.write(\`\\n⚠ Fallback: tentando conectar pelo BAL \${b.hostname || b.public_ip} (\${b.public_ip})\\n\`);
      }
    } else {
      console.log(\`[\${targetMachine.hostname}] Conectando usando BAL \${b.public_ip}\`);
    }

    try {
      const result = await sshChainExecCore(b.public_ip, balPwd, targetMachine.ip, soulPassword, cmd, isStream, onData, timeout);
      return result;
    } catch (err) {
      lastErr = err;
      if (res && isStream) {
        res.write(\`❌ Falha no BAL \${b.hostname || b.public_ip}: \${err.message}\\n\`);
      } else {
        console.log(\`[\${targetMachine.hostname}] Falha no BAL \${b.public_ip}: \${err.message}\`);
      }
    }
  }

  throw lastErr || new Error('Nenhum BAL disponivel para tentar.');
}
// ─── Fim Helpers SSH ───────────────────────────────────────────────────────────
`;

if (!code.includes('executeWithBalFallback')) {
  code = code.replace('// ─── Helpers ──────────────────────────────────────────────────────────────────', newHelpers + '\\n// ─── Helpers ──────────────────────────────────────────────────────────────────');
}

// Write the modified code back for now, we'll patch routes in a separate step or via AST tool.
fs.writeFileSync('server.js', code);
console.log('SSH helpers injected');
