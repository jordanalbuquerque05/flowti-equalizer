const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = 3333;

require('dotenv').config();

const DB_CONFIG = {
  host: process.env.DB_HOST || '137.131.181.89',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 33060,
  database: process.env.DB_NAME || 'oci_inventory',
  user: process.env.DB_USER || 'user_read_portal',
  password: process.env.DB_PASSWORD,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

const SSH_USER = process.env.SSH_USER || 'mv-portal';
const SSH_PASSWORDS = {
  MVCLIENTESAAS: process.env.SSH_PASS_MVCLIENTESAAS,
  CLOUDMVORACLE: process.env.SSH_PASS_CLOUDMVORACLE,
};

// ─── Load JSON inventory ──────────────────────────────────────────────────────
const INVENTORY_PATH = path.join(__dirname, 'inventario_geral_maquinas.json');
let inventory = [];

try {
  const raw = fs.readFileSync(INVENTORY_PATH, 'utf8');
  inventory = JSON.parse(raw);
  // Normalize: keep only entries with a valid hostname and codigo
  // Deduplicate: prefer entries with tenancy filled
  const map = new Map();
  for (const m of inventory) {
    const key = m.hostname ? m.hostname.toUpperCase() + (m.ip ? '_' + m.ip : '') : null;
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || (!existing.tenancy && m.tenancy)) {
      map.set(key, m);
    }
  }
  inventory = Array.from(map.values());
  console.log(`✅ Inventory loaded: ${inventory.length} unique machines`);
} catch (e) {
  console.error('❌ Failed to load inventory JSON:', e.message);
}


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
  const soulPassword = targetMachine.sshPassword || targetMachine.senha || Object.values(SSH_PASSWORDS)[0] || '';

  const maxTries = Math.min(2, sortedBals.length);
  for (let i = 0; i < maxTries; i++) {
    const b = sortedBals[i];
    const balPwd = b.sshPassword || b.senha || (b.tenancy ? SSH_PASSWORDS[b.tenancy] : '') || Object.values(SSH_PASSWORDS)[0];
    
    if (res && isStream) {
      if (i > 0) {
        res.write(`\n⚠ Fallback: tentando conectar pelo BAL ${b.hostname || b.public_ip} (${b.public_ip})\n`);
      }
    } else {
      console.log(`[${targetMachine.hostname}] Conectando usando BAL ${b.public_ip}`);
    }

    try {
      const result = await sshChainExecCore(b.public_ip, balPwd, targetMachine.ip, soulPassword, cmd, isStream, onData, timeout);
      return result;
    } catch (err) {
      lastErr = err;
      if (res && isStream) {
        res.write(`❌ Falha no BAL ${b.hostname || b.public_ip}: ${err.message}\n`);
      } else {
        console.log(`[${targetMachine.hostname}] Falha no BAL ${b.public_ip}: ${err.message}`);
      }
      
      // Abort immediately on auth failures to prevent long hangs or account lockouts
      if (err.message.toLowerCase().includes('authentication') || err.message.toLowerCase().includes('auth')) {
        break;
      }
    }
  }

  throw lastErr || new Error('Nenhum BAL disponivel para tentar.');
}
// ─── Fim Helpers SSH ───────────────────────────────────────────────────────────
// ─── Helpers ──────────────────────────────────────────────────────────────────
function isBAL(hostname) {
  return /\bBAL\b/i.test(hostname);
}

function getEnvLabel(hostname) {
  const h = hostname.toUpperCase();
  if (/TST/i.test(h)) return 'TST';
  if (/PRD/i.test(h)) return 'PRD';
  return 'UNKNOWN';
}

function normalizeMachine(m) {
  return {
    hostname: m.hostname || '',
    ip: m.ip || '',
    codigo: (m.codigo || '').replace(/^0+/, '') || m.codigo || '',
    codigoRaw: m.codigo || '',
    tenancy: m.tenancy || '',
    senha: m.senha || '',
    dns: m.dns || '',
    ambiente: m.ambiente || getEnvLabel(m.hostname || ''),
    sshPassword: SSH_PASSWORDS[m.tenancy] || m.senha || '',
  };
}


function dedupMachines(machines) {
  const map = new Map();
  for (const m of machines) {
    const key = m.hostname.toLowerCase() + (m.ip ? '_' + m.ip : '');
    const existing = map.get(key);
    if (!existing) {
      map.set(key, m);
    } else {
      if (m.tenancy && !existing.tenancy) {
        map.set(key, m);
      } else if (m.sshPassword && !existing.sshPassword) {
        map.set(key, m);
      }
    }
  }
  return Array.from(map.values());
}

function getBALsFromInventory(codigoSearch) {
  const search = codigoSearch.trim().toLowerCase();
  const list = inventory
    .filter((m) => {
      if (!isBAL(m.hostname || '')) return false;
      const codigo = (m.codigo || '').toLowerCase().replace(/^0+/, '');
      const codigoRaw = (m.codigo || '').toLowerCase();
      const hostname = (m.hostname || '').toLowerCase();
      return (
        codigo === search.replace(/^0+/, '') ||
        codigoRaw === search ||
        hostname.startsWith(search) ||
        hostname.startsWith(search.padStart(4, '0'))
      );
    })
    .map(normalizeMachine);
  return dedupMachines(list);
}

function getSOULsFromInventory(codigoSearch) {
  const search = codigoSearch.trim().toLowerCase();
  const list = inventory
    .filter((m) => {
      const h = (m.hostname || '').toUpperCase();
      const isApp = h.includes('SOUL') || h.includes('ERP') || h.includes('HOSP') || h.includes('-REPORT') || h.includes('PEP') || h.includes('INTEGRACAO');
      if (!isApp) return false;
      const codigo = (m.codigo || '').toLowerCase().replace(/^0+/, '');
      const codigoRaw = (m.codigo || '').toLowerCase();
      return (
        codigo === search.replace(/^0+/, '') ||
        codigoRaw === search
      );
    })
    .map(normalizeMachine);
  return dedupMachines(list);
}

function getAllClientsFromInventory() {
  const clients = new Map();
  for (const m of inventory) {
    if (!m.codigo || !isBAL(m.hostname || '')) continue;
    const codigo = m.codigo.replace(/^0+/, '').padStart(4, '0');
    if (!clients.has(codigo)) {
      clients.set(codigo, {
        codigo,
        codigoRaw: m.codigo,
        tenancy: m.tenancy || '',
        balCount: 0,
      });
    }
    clients.get(codigo).balCount++;
  }
  return Array.from(clients.values()).sort((a, b) =>
    a.codigo.localeCompare(b.codigo)
  );
}

// ─── DB helper ────────────────────────────────────────────────────────────────
let dbPool = null;

async function getDB() {
  if (!dbPool) {
    try {
      dbPool = await mysql.createPool({
        ...DB_CONFIG,
        waitForConnections: true,
        connectionLimit: 5,
      });
      await dbPool.query('SELECT 1');
      console.log('✅ MySQL connected');
    } catch (e) {
      console.warn('⚠️  MySQL not available:', e.message);
      dbPool = null;
    }
  }
  return dbPool;
}

async function getBALsFromDB(codigo) {
  try {
    const pool = await getDB();
    if (!pool) return [];
    const [rows] = await pool.query(
      `SELECT hostname, private_ip as ip, public_ip, client_code as codigo,
              tenancy_name as tenancy
       FROM instances
       WHERE (client_code = ? OR client_code = LPAD(?, 4, '0'))
         AND UPPER(hostname) LIKE '%BAL%'`,
      [codigo, codigo]
    );
    return rows.map((r) => ({
      ...r,
      tenancy: r.tenancy || '',
      sshPassword: SSH_PASSWORDS[r.tenancy] || '',
      senha: SSH_PASSWORDS[r.tenancy] || '',
      ambiente: getEnvLabel(r.hostname || ''),
      dns: r.hostname + '.cloudmv.com.br'
    }));
  } catch (e) {
    console.warn('DB query error:', e.message);
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') dbPool = null;
    return [];
  }
}

// ─── Cache Mechanism for Tomcats ────────────────────────────────────────────────
const TOMCAT_CACHE_FILE = path.join(__dirname, 'tomcat_cache.json');
let tomcatCache = {};
if (fs.existsSync(TOMCAT_CACHE_FILE)) {
  try {
    tomcatCache = JSON.parse(fs.readFileSync(TOMCAT_CACHE_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load tomcat_cache.json', e.message);
  }
}

function saveTomcatCache() {
  fs.writeFile(TOMCAT_CACHE_FILE, JSON.stringify(tomcatCache, null, 2), err => {
    if (err) console.error('Failed to save tomcat_cache.json', err.message);
  });
}

function getTargetDir(ambiente) {
  return ambiente === 'PRD' ? 'soulmv_prd' : 'soulmv_trn';
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));

// Trava global para prevenir acessos simultâneos a operações críticas
let isServerProcessing = false;
app.use('/api', (req, res, next) => {
  const criticalRoutes = ['/batch-update', '/sync-release', '/rollback-tomcat', '/restart-tomcat', '/change-version'];
  if (criticalRoutes.some(r => req.path.includes(r))) {
    if (isServerProcessing) {
      return res.status(429).json({ success: false, error: "Já existe uma operação crítica em andamento no servidor. Aguarde o término." });
    }
    isServerProcessing = true;
    // Libera a trava quando a resposta for finalizada ou a conexão cair
    res.on('finish', () => { isServerProcessing = false; });
    res.on('close', () => { isServerProcessing = false; });
  }
  next();
});


// List all clients with at least one BAL
app.get('/api/clients', (req, res) => {
  const clients = getAllClientsFromInventory();
  res.json({ success: true, data: clients, count: clients.length });
});

// Helper para isolar execução de comandos SSH via Heredoc
function execSSHStep(client, command, onData) {
  return new Promise((resolve, reject) => {
    const fullCmd = `sudo su - << 'ENDSSH'\n${command}\nENDSSH\n`;
    client.exec(fullCmd, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      stream.on('data', d => {
        const chunk = d.toString();
        output += chunk;
        if (onData) onData(chunk);
      });
      stream.stderr.on('data', d => {
        const chunk = d.toString();
        output += chunk;
        if (onData) onData(chunk);
      });
      stream.on('close', (code, signal) => {
        resolve({ code, signal, output });
      });
    });
  });
}

// Endpoint para reiniciar o tomcat (lógica: stop → cleanup → start → log)
app.post('/api/restart-tomcat', async (req, res) => {
  const { hostnames, targetEnv, produto, balHost, balTenancy, bals } = req.body;

  if (!hostnames || !hostnames.length || !targetEnv || !produto || !balHost || !balTenancy) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');

  const onData = (chunk) => {
    res.write(chunk);
  };

  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0] };
  };

  const machines = inventory.filter(m => m.ambiente === targetEnv && hostnames.includes(m.hostname));
  if (machines.length === 0) {
    res.write(`❌ Nenhuma máquina encontrada para os parâmetros informados.\n`);
    res.end();
    return;
  }

  for (const machine of machines) {
    res.write(`\n----------------------------------------\n`);
    res.write(`=== Conectando na máquina: ${machine.hostname} (${machine.ambiente}) ===\n`);

    const soulPassword = SSH_PASSWORDS[machine.tenancy] || Object.values(SSH_PASSWORDS)[0];
    const mBal = getBalForEnv(machine.ambiente);
    const targetDir = getTargetDir(machine.ambiente);
    let cachedTomcat = tomcatCache[machine.ip] ? tomcatCache[machine.ip][produto] : null;

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { 
          if (!settled) { settled = true; reject(new Error('Timeout geral de 5 minutos excedido na máquina ' + machine.hostname)); } 
        }, 300000);

        const jumpClient = new Client();
        jumpClient.on('ready', () => {
          jumpClient.forwardOut('127.0.0.1', 0, machine.ip, 22, (err, stream) => {
            if (err) {
              clearTimeout(timer); jumpClient.end();
              if (!settled) { settled = true; reject(err); }
              return;
            }
            const soulClient = new Client();
            soulClient.on('ready', async () => {
              try {
                // Etapa 0: Descobrir o ID/porta do Tomcat
                let findTomcatCmd = '';
                if (cachedTomcat) {
                  findTomcatCmd = `tomcat_name="${cachedTomcat}"\ntomcat_port=$(echo "$tomcat_name" | grep -oP '\\d+')\necho "$tomcat_port"`;
                } else {
                  findTomcatCmd = `
xml=$(ls /MV/servers/${targetDir}/*/conf/Catalina/localhost/${produto}.xml 2>/dev/null | head -1)
if [ -z "$xml" ]; then exit 1; fi
tomcat_name=$(echo "$xml" | awk -F'/' '{print $5}')
tomcat_port=$(echo "$tomcat_name" | grep -oP '\\d+')
echo "$tomcat_port"
`;
                }
                
                let res0 = await execSSHStep(soulClient, findTomcatCmd);
                if (res0.code !== 0 || !res0.output.trim()) {
                   throw new Error(`Produto ${produto} não encontrado ou sem porta no ambiente ${targetDir}.`);
                }
                const outputLines = res0.output.trim().split('\n');
                const tomcatId = outputLines[outputLines.length - 1].trim();
                res.write(`✅ Tomcat encontrado: ID ${tomcatId}\n`);

                // Etapa 1: STOP via tomcatctl
                res.write(`\n=== [1/4] Executando: tomcatctl stop ${tomcatId} ===\n`);
                let resStop = await execSSHStep(soulClient, `tomcatctl stop "${tomcatId}" 2>&1`, onData);
                if (resStop.code !== 0) {
                  res.write(`⚠️ tomcatctl stop retornou código ${resStop.code}, tentando kill -9 como fallback...\n`);
                  const killCmd = `
PS_OUTPUT=$(ps aux | grep "[j]ava" | grep "${tomcatId}")
TOM_PID=$(echo "$PS_OUTPUT" | awk '{print $2}' | head -1)
if [ -n "$TOM_PID" ]; then
  echo "Matando processo PID $TOM_PID (kill -9)..."
  kill -9 "$TOM_PID"
  sleep 3
  echo "✅ Processo $TOM_PID finalizado via kill -9."
else
  echo "⚠️ Nenhum processo Java encontrado para o tomcat ${tomcatId}."
fi
`;
                  await execSSHStep(soulClient, killCmd, onData);
                }

                // Etapa 2: Verificar status (confirmar que parou)
                res.write(`\n=== [2/4] Verificando status via tomcatctl ===\n`);
                const statusCmd = `
STATUS_OUTPUT=$(tomcatctl status "${tomcatId}" 2>&1)
echo "$STATUS_OUTPUT"
if echo "$STATUS_OUTPUT" | grep -qiE "STRT|running|ativo"; then exit 1; fi
`;
                let resStatus = await execSSHStep(soulClient, statusCmd, onData);
                if (resStatus.code !== 0) throw new Error('Tomcat ainda aparece como RODANDO após o stop.');
                res.write(`✅ Status verificado. Tomcat parado.\n`);

                // Etapa 3: CLEANUP via tomcatctl
                res.write(`\n=== [3/4] Executando: tomcatctl cleanup ${tomcatId} ===\n`);
                let resCleanup = await execSSHStep(soulClient, `tomcatctl cleanup "${tomcatId}" 2>&1`, onData);
                if (resCleanup.code !== 0) throw new Error('Comando cleanup falhou.');
                res.write(`✅ CLEANUP concluído.\n`);

                // Etapa 4: START via tomcatctl
                res.write(`\n=== [4/4] Executando: tomcatctl start ${tomcatId} ===\n`);
                let resStart = await execSSHStep(soulClient, `tomcatctl start "${tomcatId}" 2>&1`, onData);
                if (resStart.code !== 0) throw new Error('Comando start falhou.');
                res.write(`✅ START executado.\n`);

                // Etapa Bônus: Capturar últimas linhas do log para confirmar inicialização
                res.write(`\n=== Capturando últimos logs do catalina.out ===\n`);
                const logCmd = `tail -n 50 /MV/servers/${targetDir}/tomcat${tomcatId}/logs/catalina.out 2>/dev/null || tail -n 50 /MV/servers/*/tomcat${tomcatId}/logs/catalina.out 2>/dev/null || echo "Log não encontrado."`;
                await execSSHStep(soulClient, logCmd, onData);
                
                res.write(`\n=== Restart concluído: ${machine.hostname} / tomcat ${tomcatId} ===\n`);

                clearTimeout(timer);
                soulClient.end(); jumpClient.end();
                if (!settled) { settled = true; resolve(); }
              } catch (stepErr) {
                res.write(`\n❌ Interrompido: ${stepErr.message}\n`);
                clearTimeout(timer);
                soulClient.end(); jumpClient.end();
                if (!settled) { settled = true; resolve(); } 
              }
            });
            soulClient.on('error', err3 => {
              clearTimeout(timer); jumpClient.end();
              if (!settled) { settled = true; reject(err3); }
            });
            soulClient.connect({ sock: stream, username: SSH_USER, password: soulPassword, readyTimeout: 7500 });
          });
        });
        jumpClient.on('error', err => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(err); }
        });
        jumpClient.connect({ host: mBal.host, port: 22, username: SSH_USER, password: mBal.pass, readyTimeout: 6000 });
      });
    } catch (err) {
      res.write(`❌ Erro no restart via SSH: ${err.message}\n`);
    }
  }

  res.write(`\n✅ Processo de restart concluído!\n`);
  res.end();
});

// Endpoint para rollback
app.post('/api/rollback-tomcat', async (req, res) => {
  const { hostnames, targetEnv, produto, backupPath, balHost, balTenancy } = req.body;

  if (!hostnames || !hostnames.length || !targetEnv || !produto || !backupPath || !balHost || !balTenancy) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const onData = (chunk) => {
    res.write(chunk);
  };

  const machines = inventory.filter(m => m.ambiente === targetEnv && hostnames.includes(m.hostname));
  if (machines.length === 0) {
    res.write(`❌ Nenhuma máquina encontrada para os parâmetros informados.\n`);
    res.end();
    return;
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];

  for (const machine of machines) {
    res.write(`\n----------------------------------------\n`);
    res.write(`=== Conectando na máquina: ${machine.hostname} (${machine.ambiente}) ===\n`);

    const soulPassword = SSH_PASSWORDS[machine.tenancy] || Object.values(SSH_PASSWORDS)[0];

    const targetDir = getTargetDir(machine.ambiente);
    let cachedTomcat = tomcatCache[machine.ip] ? tomcatCache[machine.ip][produto] : null;

    let findTomcatLogic;
    if (cachedTomcat) {
      findTomcatLogic = `
tomcat_name="${cachedTomcat}"
xml="/MV/servers/${targetDir}/$tomcat_name/conf/Catalina/localhost/${produto}.xml"
echo ">> [CACHE] Produto ${produto} mapeado no Tomcat: $tomcat_name"
`;
    } else {
      findTomcatLogic = `
xml=$(ls /MV/servers/${targetDir}/*/conf/Catalina/localhost/${produto}.xml 2>/dev/null | head -1)
if [ -z "$xml" ]; then
  echo "❌ Produto ${produto} não encontrado no ambiente ${targetDir} da máquina ${machine.hostname}"
  exit 1
fi
tomcat_name=$(echo "$xml" | awk -F'/' '{print $5}')
`;
    }

    const cmd = `sudo su << 'EOF'
${findTomcatLogic}
backup_file="${backupPath}/$tomcat_name/$(basename "$xml")"

if [ -f "$backup_file" ]; then
  echo ">> Restaurando backup de $backup_file para $xml"
  cp "$backup_file" "$xml"
  if [ $? -eq 0 ]; then
    echo "=== Rollback do produto ${produto} concluído com sucesso! ==="
  else
    echo "❌ Erro ao copiar o arquivo de backup."
  fi
else
  echo "❌ Arquivo de backup não encontrado: $backup_file"
fi
EOF
    `;

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Timeout general')); } }, 60000);

        const jumpClient = new Client();
        jumpClient.on('ready', () => {
          jumpClient.forwardOut('127.0.0.1', 0, machine.ip, 22, (err, stream) => {
            if (err) {
              clearTimeout(timer); jumpClient.end();
              if (!settled) { settled = true; reject(err); }
              return;
            }
            const soulClient = new Client();
            soulClient.on('ready', () => {
              soulClient.exec(cmd, (err2, s) => {
                if (err2) {
                  clearTimeout(timer); soulClient.end(); jumpClient.end();
                  if (!settled) { settled = true; reject(err2); }
                  return;
                }
                s.on('data', d => { if (onData) onData(d.toString()); });
                s.stderr.on('data', d => { if (onData) onData(d.toString()); });
                s.on('close', () => {
                  clearTimeout(timer); soulClient.end(); jumpClient.end();
                  if (!settled) { settled = true; resolve(); }
                });
              });
            });
            soulClient.on('error', err3 => {
              clearTimeout(timer); jumpClient.end();
              if (!settled) { settled = true; reject(err3); }
            });
            soulClient.connect({ sock: stream, username: SSH_USER, password: soulPassword, readyTimeout: 7500 });
          });
        });
        jumpClient.on('error', err => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(err); }
        });
        jumpClient.connect({ host: balHost, port: 22, username: SSH_USER, password: balPassword, readyTimeout: 6000 });
      });
    } catch (err) {
      res.write(`❌ Erro no rollback via SSH: ${err.message}\n`);
    }
  }

  res.write(`\n✅ Processo de rollback concluído!\n`);
  res.end();
});

// Endpoint para sincronização de Release (PRD -> TST)
// ─── Check if a release already exists in TST ─────────────────────────────────
app.post('/api/check-release-exists', async (req, res) => {
  const { balHost, balTenancy, bals, tstMachine, produto, release } = req.body;
  if (!tstMachine || !produto || !release) {
    return res.status(400).json({ success: false, error: 'Faltam parâmetros' });
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];
  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: balPassword };
  };

  const tstPwd = SSH_PASSWORDS[tstMachine.tenancy] || Object.values(SSH_PASSWORDS)[0];
  const mBal = getBalForEnv(tstMachine.ambiente);
  const tstPath = `/MV/apps/soulmv_trn/products/${produto}/${release}`;
  const cmd = `if [ -d "${tstPath}/forms" ] || [ -d "${tstPath}/uploadfiles" ]; then echo "EXISTS"; else echo "NOT_EXISTS"; fi`;

  try {
    const result = await new Promise((resolve, reject) => {
      const jumpClient = new Client();
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; jumpClient.end(); reject(new Error('Timeout')); } }, 15000);
      jumpClient.on('ready', () => {
        jumpClient.forwardOut('127.0.0.1', 0, tstMachine.ip, 22, (err, stream) => {
          if (err) { clearTimeout(timer); jumpClient.end(); if (!settled) { settled = true; reject(err); } return; }
          const soulClient = new Client();
          soulClient.on('ready', () => {
            let out = '';
            soulClient.exec(cmd, (err2, s) => {
              if (err2) { clearTimeout(timer); soulClient.end(); jumpClient.end(); if (!settled) { settled = true; reject(err2); } return; }
              s.on('data', d => { out += d.toString(); });
              s.stderr.on('data', () => {});
              s.on('close', () => { clearTimeout(timer); soulClient.end(); jumpClient.end(); if (!settled) { settled = true; resolve(out.trim()); } });
            });
          });
          soulClient.on('error', e => { clearTimeout(timer); jumpClient.end(); if (!settled) { settled = true; reject(e); } });
          soulClient.connect({ sock: stream, username: SSH_USER, password: tstPwd, readyTimeout: 7500 });
        });
      });
      jumpClient.on('error', err => { clearTimeout(timer); if (!settled) { settled = true; reject(err); } });
      jumpClient.connect({ host: mBal.host, port: 22, username: SSH_USER, password: mBal.pass, readyTimeout: 6000 });
    });

    res.json({ success: true, exists: result.includes('EXISTS') });
  } catch (e) {
    res.json({ success: false, error: e.message, exists: false });
  }
});

app.post('/api/sync-release', async (req, res) => {

  const { produto, release, prdMachine, tstMachine, prdTomcat, tstTomcat, tstInstalledVer, balHost, balTenancy, bals, forceOverwrite } = req.body;

  if (!produto || !release || !prdMachine || !tstMachine || !prdTomcat || !tstTomcat) {
    return res.status(400).json({ error: 'Faltam parâmetros obrigatórios' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  let isCancelled = false;
  req.on('close', () => { isCancelled = true; });

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];
  const prdPassword = SSH_PASSWORDS[prdMachine.tenancy] || Object.values(SSH_PASSWORDS)[0];
  const tstPassword = SSH_PASSWORDS[tstMachine.tenancy] || Object.values(SSH_PASSWORDS)[0];

  res.write(`\n======================================================\n`);
  res.write(`🚀 INICIANDO SINCRONIZAÇÃO DE RELEASE\n`);
  res.write(`📦 Produto: ${produto}\n`);
  res.write(`🏷️ Release: ${release}\n`);
  res.write(`🏢 Origem: ${prdMachine.hostname} (${prdTomcat})\n`);
  res.write(`🏗️ Destino: ${tstMachine.hostname} (${tstTomcat})\n`);
  res.write(`======================================================\n\n`);

  let prdJumpClient, prdSoulClient;
  let tstJumpClient, tstSoulClient;

  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: balPassword };
  };

  // Helper para conectar
  const connectMachine = async (machine, password) => {
    const mBal = getBalForEnv(machine.ambiente);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Timeout connecting to ' + machine.hostname)); } }, 20000);

      const jumpClient = new Client();
      jumpClient.on('ready', () => {
        jumpClient.forwardOut('127.0.0.1', 0, machine.ip, 22, (err, stream) => {
          if (err) { clearTimeout(timer); jumpClient.end(); if (!settled) { settled = true; reject(err); } return; }
          const soulClient = new Client();
          soulClient.on('ready', () => {
            clearTimeout(timer);
            if (!settled) { settled = true; resolve({ jumpClient, soulClient }); }
          });
          soulClient.on('error', err3 => {
            clearTimeout(timer); jumpClient.end();
            if (!settled) { settled = true; reject(err3); }
          });
          soulClient.connect({ sock: stream, username: SSH_USER, password: password, readyTimeout: 7500 });
        });
      });
      jumpClient.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });
      jumpClient.connect({ host: mBal.host, port: 22, username: SSH_USER, password: mBal.pass, readyTimeout: 6000 });
    });
  };

  try {
    res.write(`>> [1/4] Conectando nos servidores PRD e TST simultaneamente...\n`);
    if (isCancelled) { res.write(`\n⚠️ Processo cancelado pelo usuário!\n`); res.end(); return; }
    const [prdConn, tstConn] = await Promise.all([
      connectMachine(prdMachine, prdPassword),
      connectMachine(tstMachine, tstPassword)
    ]);

    prdJumpClient = prdConn.jumpClient; prdSoulClient = prdConn.soulClient;
    tstJumpClient = tstConn.jumpClient; tstSoulClient = tstConn.soulClient;
    res.write(`✅ Conexões estabelecidas com sucesso!\n\n`);

    // Função auxiliar super robusta para executar comandos e printar TUDO
    const execCmd = (client, cmd, stepName, timeoutMs = 15000) => {
      return new Promise((resolve, reject) => {
        client.exec(cmd, (err, stream) => {
          if (err) return reject(err);
          let out = '', errOut = '', finished = false;

          const timer = setTimeout(() => {
            if (!finished) reject(new Error(`Timeout (${timeoutMs}ms) na etapa: ${stepName}`));
          }, timeoutMs);

          stream.on('data', d => {
            out += d.toString();
            const lines = d.toString().split('\n');
            for (let l of lines) if (l.trim()) res.write(`   [${stepName}] ${l.trim()}\n`);
          });

          stream.stderr.on('data', d => {
            errOut += d.toString();
            const lines = d.toString().split('\n');
            for (let l of lines) if (l.trim()) res.write(`   [${stepName} - ERRO] ${l.trim()}\n`);
          });

          stream.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            resolve({ code, stdout: out.trim(), stderr: errOut.trim() });
          });

          stream.on('error', e => {
            finished = true;
            clearTimeout(timer);
            reject(e);
          });
        });
      });
    };

    // PASSO 1: Pegar CATALINA_HOME de PRD
    res.write(`>> [2/4] Coletando versão do Tomcat em PRD (/etc/init.d/${prdTomcat})...\n`);
    const cmd1 = `sudo su -c "cat /etc/init.d/${prdTomcat} | grep -E '^export CATALINA_HOME=' | awk -F'=' '{print \\$2}' | tr -d '\\"'"`;
    const res1 = await execCmd(prdSoulClient, cmd1, 'PRD-CATALINA');
    let prdCatalinaHome = res1.stdout;

    if (!prdCatalinaHome) {
      throw new Error(`Não foi possível encontrar CATALINA_HOME no PRD (${prdTomcat})`);
    }
    res.write(`✅ CATALINA_HOME no PRD: ${prdCatalinaHome}\n\n`);

    // PASSO 2: Aplicar CATALINA_HOME em TST
    res.write(`>> [3/5] Atualizando script do Tomcat em TST (/etc/init.d/${tstTomcat})...\n`);
    const sedCmd = `sudo su -c "sed -i 's|^export CATALINA_HOME=.*|export CATALINA_HOME=\\"${prdCatalinaHome}\\"|g' /etc/init.d/${tstTomcat}"`;
    const res2 = await execCmd(tstSoulClient, sedCmd, 'TST-SED-CATALINA');
    if (res2.code !== 0) throw new Error(res2.stderr || 'Erro ao atualizar CATALINA no TST');
    res.write(`✅ CATALINA_HOME do TST equalizado com sucesso!\n\n`);

    // PASSO 3: Copiar tomcat-version.txt
    res.write(`>> [4/5] Copiando arquivo tomcat-version.txt do PRD...\n`);
    const cmd3 = `sudo su -c "cat /MV/servers/*/${prdTomcat}/conf/tomcat-version.txt 2>/dev/null || true"`;
    const res3 = await execCmd(prdSoulClient, cmd3, 'PRD-READ-VERSION');
    let prdTomcatVersionTxt = res3.stdout;

    if (prdTomcatVersionTxt) {
      const b64 = Buffer.from(prdTomcatVersionTxt).toString('base64');
      const setVerCmd = `sudo su -c "sh -c 'for d in /MV/servers/*/${tstTomcat}/conf; do if [ -d \\"\\$d\\" ]; then echo \\"${b64}\\" | base64 -d > \\"\\$d/tomcat-version.txt\\"; fi; done'"`;
      const res4 = await execCmd(tstSoulClient, setVerCmd, 'TST-WRITE-VERSION');
      if (res4.code !== 0) throw new Error(res4.stderr || 'Erro ao escrever tomcat-version.txt no TST');
      res.write(`✅ tomcat-version.txt do TST atualizado com sucesso!\n\n`);
    } else {
      res.write(`⚠️ tomcat-version.txt não encontrado no PRD, ignorando este passo.\n\n`);
    }

    // PASSO 4: SCP (Tar Pipe)
    res.write(`>> [5/5] Sincronizando pasta 'forms' de PRD para TST (Pipe Direto)...\n`);
    console.log(`[SYNC] 5/5 - Sincronizando arquivos (tar pipe). Acompanhando logs de transferência...`);
    const prdPath = `/MV/apps/soulmv_prd/products/${produto}/${release}`;
    const tstPath = `/MV/apps/soulmv_trn/products/${produto}/${release}`;

    await execCmd(tstSoulClient, `sudo su -c "mkdir -p ${tstPath}"`, 'TST-MKDIR');

    // Se o usuario confirmou sobrescrita, apaga a pasta forms antes de copiar
    if (forceOverwrite) {
      res.write(`   - Removendo pastas 'forms' e 'uploadfiles' antigas em TST (forceOverwrite)...\n`);
      await execCmd(tstSoulClient, `sudo su -c "rm -rf ${tstPath}/forms ${tstPath}/uploadfiles"`, 'TST-RM-DIRS');
      res.write(`   ✅ Pastas antigas removidas!\n`);
    }

    res.write(`   - Compactando 'forms' e 'uploadfiles' (se existir) de PRD\n`);
    res.write(`   - Extraindo em ${tstPath}\n`);

    await new Promise((resolve, reject) => {
      // Lista condicionalmente forms e uploadfiles para empacotar, ignorando uploadfiles dentro de forms
      const tarCmd = `sudo su -c "cd ${prdPath} && tar --exclude='forms/uploadfiles' -czf - \\$([ -d forms ] && echo forms) \\$([ -d uploadfiles ] && echo uploadfiles)"`;
      prdSoulClient.exec(tarCmd, (err, prdStream) => {
        if (err) return reject(err);

        prdStream.stderr.on('data', d => {
          const str = d.toString();
          const lines = str.split('\n');
          for (let l of lines) if (l.trim()) res.write(`   [PRD-TAR-ERRO] ${l.trim()}\n`);
        });

        tstSoulClient.exec(`sudo su -c "tar -xzvf - -C ${tstPath}"`, (err2, tstStream) => {
          if (err2) return reject(err2);

          let tstErr = '';
          tstStream.stderr.on('data', d => {
            const str = d.toString();
            tstErr += str;
            const lines = str.split('\n');
            for (let l of lines) if (l.trim()) res.write(`   [TST-TAR] ${l.trim()}\n`);
          });

          tstStream.on('data', d => {
            const lines = d.toString().split('\n');
            for (let l of lines) if (l.trim()) res.write(`   [TST-TAR] ${l.trim()}\n`);
          });

          prdStream.pipe(tstStream);

          tstStream.on('close', (code) => {
            if (code !== 0 && !tstErr.includes('forms/') && !tstErr.includes('uploadfiles/')) reject(new Error(tstErr || 'Erro no tar TST'));
            else resolve();
          });

          prdStream.on('error', (e) => reject(e));
          tstStream.on('error', (e) => reject(e));
        });
      });
    });

    res.write(`✅ Arquivos transferidos com sucesso!\n`);

    // NOVO PASSO: Copiar conf da release anterior para a nova
    if (tstInstalledVer && tstInstalledVer !== release) {
      res.write(`>> [6/7] Copiando pasta 'conf' da versão atual (${tstInstalledVer}) para a nova (${release}) no TST...\n`);
      const oldConfPath = `/MV/apps/soulmv_trn/products/${produto}/${tstInstalledVer}/conf`;
      const newReleasePath = `/MV/apps/soulmv_trn/products/${produto}/${release}`;
      const cpCmd = `sudo su -c "if [ -d \\"${oldConfPath}\\" ]; then cp -R \\"${oldConfPath}\\" \\"${newReleasePath}/\\"; fi"`;
      await execCmd(tstSoulClient, cpCmd, 'TST-CP-CONF');
      res.write(`✅ Pasta 'conf' copiada!\n\n`);
    } else {
      res.write(`>> [6/7] Copiando pasta 'conf' - Ignorado (versão atual é igual a nova ou não identificada).\n\n`);
    }

    res.write(`>> [7/7] Ajustando permissões (chown mv.mv) no TST...\n`);
    await execCmd(tstSoulClient, `sudo su -c "chown -R mv.mv ${tstPath}"`, 'TST-CHOWN');
    res.write(`✅ Permissões ajustadas!\n`);

    res.write(`\n🎉 PROCESSO CONCLUÍDO COM SUCESSO!\n`);

  } catch (err) {
    res.write(`\n❌ ERRO CRÍTICO DURANTE A SINCRONIZAÇÃO:\n${err.message}\n`);
  } finally {
    if (prdSoulClient) prdSoulClient.end();
    if (prdJumpClient) prdJumpClient.end();
    if (tstSoulClient) tstSoulClient.end();
    if (tstJumpClient) tstJumpClient.end();
    res.end();
  }
});

app.get('/api/inventory', (req, res) => {
  const clients = getAllClientsFromInventory();
  res.json({ success: true, data: clients, count: clients.length });
});

// Get BAL machines for a specific client code
app.get('/api/machines', async (req, res) => {
  const { codigo } = req.query;
  if (!codigo) {
    return res.status(400).json({ success: false, error: 'Missing "codigo" param' });
  }

  let machines = getBALsFromInventory(codigo);

  // Sempre busca no DB e faz o merge
  const dbMachines = await getBALsFromDB(codigo);
  if (dbMachines && dbMachines.length > 0) {
    machines = dedupMachines(machines.concat(dbMachines));
  }

  // Sort: PRD first, then TST; then by hostname
  machines.sort((a, b) => {
    if (a.ambiente !== b.ambiente) return a.ambiente === 'PRD' ? -1 : 1;
    return a.hostname.localeCompare(b.hostname);
  });

  // Enrich with public IP from instances table
  try {
    const pool = await getDB();
    if (pool && machines.length > 0) {
      const hostnames = machines.map(m => m.hostname);
      const [rows] = await pool.query(
        `SELECT hostname, public_ip FROM instances WHERE hostname IN (?)`,
        [hostnames]
      );
      const pubIpMap = {};
      for (const r of rows) {
        if (r.public_ip && r.public_ip !== '---') {
          pubIpMap[r.hostname] = r.public_ip;
        }
      }
      for (const m of machines) {
        if (pubIpMap[m.hostname]) {
          m.public_ip = pubIpMap[m.hostname];
        }
      }
    }
  } catch (e) {
    console.warn('Failed to get public_ips:', e.message);
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') dbPool = null;
  }

  res.json({
    success: true,
    codigo,
    count: machines.length,
    data: machines,
  });
});

// Search/autocomplete clients
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ success: true, data: [] });
  const query = q.trim().toLowerCase();
  const clients = getAllClientsFromInventory().filter(
    (c) =>
      c.codigo.includes(query) ||
      c.codigoRaw.toLowerCase().includes(query)
  );
  res.json({ success: true, data: clients.slice(0, 20) });
});

// DB status check
app.get('/api/db-status', async (req, res) => {
  try {
    const pool = await getDB();
    if (!pool) return res.json({ connected: false });
    await pool.query('SELECT 1');
    res.json({ connected: true });
  } catch {
    res.json({ connected: false });
  }
});

// ─── SOUL Machines for a client ───────────────────────────────────────────────
app.get('/api/soul-machines', async (req, res) => {
  const { codigo } = req.query;
  if (!codigo) return res.status(400).json({ success: false, error: 'Missing codigo' });

  try {
    let soulMachines = getSOULsFromInventory(codigo);
    let bals = getBALsFromInventory(codigo).filter(m => m.public_ip && m.public_ip !== '---');

    // Sempre busca no BD e mescla com a memória
    const pool = await getDB();
    if (pool) {
      const padded = codigo.replace(/^0+/, '').padStart(4, '0');

      const [soulRows] = await pool.query(
        `SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
         FROM instances
         WHERE (client_code = ? OR client_code = ?)
           AND (
             UPPER(hostname) LIKE '%SOUL%' OR
             UPPER(hostname) LIKE '%ERP%'  OR
             UPPER(hostname) LIKE '%HOSP%' OR
             UPPER(hostname) LIKE '%-REPORT%' OR
             UPPER(hostname) LIKE '%PEP%'  OR
             UPPER(hostname) LIKE '%INTEGRACAO%'
           )
         ORDER BY hostname`,
        [codigo, padded]
      );
      const dbSoul = soulRows.map(m => ({
        ...m,
        ambiente: getEnvLabel(m.hostname),
        sshPassword: SSH_PASSWORDS[m.tenancy] || '',
      }));
      soulMachines = dedupMachines(soulMachines.concat(dbSoul));

      const [balRows] = await pool.query(
        `SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
         FROM instances
         WHERE (client_code = ? OR client_code = ?)
           AND UPPER(hostname) LIKE '%BAL%'
           AND public_ip IS NOT NULL AND public_ip != '---'
         ORDER BY hostname`,
        [codigo, padded]
      );
      const dbBals = balRows.map(m => ({
        ...m,
        ambiente: getEnvLabel(m.hostname),
        sshPassword: SSH_PASSWORDS[m.tenancy] || '',
      }));
      bals = dedupMachines(bals.concat(dbBals));
    }

    res.json({ success: true, soulMachines, bals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Check Versions via SSH chain: BAL → SOUL ─────────────────────────────────
app.post('/api/check-versions', async (req, res) => {
  const { balHost, balTenancy, machines, bals } = req.body;
  if (!balHost || !machines || !machines.length) {
    return res.status(400).json({ success: false, error: 'Missing balHost or machines' });
  }

  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
      return { host: bals[0].public_ip, pass: SSH_PASSWORDS[bals[0].tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0] };
  };

  // Command is generated per machine in the loop based on its environment

  function sshExec(host, password, cmd, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let output = '';
      const timer = setTimeout(() => {
        client.end();
        reject(new Error('Timeout'));
      }, timeout);

      client.on('ready', () => {
        client.exec(cmd, (err, stream) => {
          if (err) { clearTimeout(timer); client.end(); return reject(err); }
          stream.on('data', d => { output += d.toString(); });
          stream.stderr.on('data', () => { });
          stream.on('close', () => { clearTimeout(timer); client.end(); resolve(output); });
        });
      });

      client.on('error', err => { clearTimeout(timer); reject(err); });

      client.connect({ host, port: 22, username: SSH_USER, password, readyTimeout: 15000 });
    });
  }

  function sshChainExec(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, timeout = 35000) {
    return new Promise((resolve, reject) => {
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
              s.on('data', d => { output += d.toString(); });
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

          soulClient.connect({ sock: stream, username: SSH_USER, password: soulPwd, readyTimeout: 15000 });
        });
      });

      jumpClient.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });

      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 7500 });
    });
  }

  function parseVersionOutput(raw) {
    const tomcats = {};
    for (const line of raw.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length !== 3) continue;
      const [tomcat, produto, versao] = parts;
      if (!tomcat || !produto) continue;
      if (!tomcats[tomcat]) tomcats[tomcat] = [];
      tomcats[tomcat].push({ produto, versao: versao || 'unknown' });
    }
    return tomcats;
  }

  const results = [];

  for (const machine of machines) {
    const soulPassword = SSH_PASSWORDS[machine.tenancy] || Object.values(SSH_PASSWORDS)[0];
    const targetDir = getTargetDir(machine.ambiente);
    const dynamicCMD = `
for serverdir in /MV/servers/${targetDir}/; do
  [ -d "$serverdir" ] || continue
  for dir in "$serverdir"/*/; do
    [ -d "$dir" ] || continue
    tomcat=$(basename "$dir")
    lhpath="$dir/conf/Catalina/localhost"
    [ -d "$lhpath" ] || continue
    for xml in "$lhpath"/*.xml; do
      [ -f "$xml" ] || continue
      produto=$(basename "$xml" .xml)
      versao=$(grep -oP 'docBase="[^"]*products/[^/]+/\\K[^/]+' "$xml" 2>/dev/null | head -1)
      [ -z "$versao" ] && versao=$(grep -oP '\\d{4}\\.\\d+\\.\\d+-[A-Z]+' "$xml" 2>/dev/null | head -1)
      [ -z "$versao" ] && versao="unknown"
      echo "$tomcat|$produto|$versao"
    done
  done
done
    `.trim();

    const mBal = getBalForEnv(machine.ambiente);
    try {
      const raw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: dynamicCMD, isStream: false, onData: null, timeout: 35000, res: null });
      const tomcats = parseVersionOutput(raw);

      // Update cache
      if (!tomcatCache[machine.ip]) tomcatCache[machine.ip] = {};
      for (const [tomcat, prods] of Object.entries(tomcats)) {
        for (const p of prods) {
          tomcatCache[machine.ip][p.produto] = tomcat;
        }
      }

      results.push({ hostname: machine.hostname, ambiente: machine.ambiente, ip: machine.ip, success: true, tomcats });
    } catch (e) {
      results.push({ hostname: machine.hostname, ambiente: machine.ambiente, ip: machine.ip, success: false, error: e.message, tomcats: {} });
    }
  }

  saveTomcatCache();

  res.json({ success: true, results });
});

// ─── Check Available Releases via SSH chain: BAL → APP Machine ────────────────
app.post('/api/check-releases', async (req, res) => {
  const { balHost, balTenancy, machines, bals } = req.body;
  if (!balHost || !machines || !machines.length) {
    return res.status(400).json({ success: false, error: 'Missing balHost or machines' });
  }

  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
      return { host: bals[0].public_ip, pass: SSH_PASSWORDS[bals[0].tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0] };
  };

  function buildReleasesCmd(ambiente) {
    // TST machines → soulmv_trn; PRD machines → soulmv_prd
    const isPrd = /prd/i.test(ambiente);
    const appBase = isPrd
      ? '/MV/apps/soulmv_prd/products'
      : '/MV/apps/soulmv_trn/products';

    return `
APP_BASE="${appBase}"
if [ -d "$APP_BASE" ]; then
  for product_dir in "$APP_BASE"/*/; do
    [ -d "$product_dir" ] || continue
    prod=$(basename "$product_dir")
    for ver_dir in "$product_dir"*/; do
      [ -d "$ver_dir" ] || continue
      ver=$(basename "$ver_dir")
      echo "$prod|$ver"
    done
  done
else
  echo "PATH_NOT_FOUND|$APP_BASE"
fi
`.trim();
  }

  function sshChainExec(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, timeout = 15000) {
    return new Promise((resolve, reject) => {
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
              s.on('data', d => { output += d.toString(); });
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
          soulClient.connect({ sock: stream, username: SSH_USER, password: soulPwd, readyTimeout: 7500 });
        });
      });

      jumpClient.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });

      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 6000 });
    });
  }

  function parseReleasesOutput(raw) {
    const products = {};
    for (const line of raw.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length !== 2) continue;
      const [produto, versao] = parts;
      if (!produto || !versao) continue;
      if (!products[produto]) products[produto] = [];
      // Sort versions: only keep RELEASE-like entries
      products[produto].push(versao);
    }
    // Sort versions descending (newest first)
    for (const k of Object.keys(products)) {
      products[k].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    }
    return products;
  }

  const results = [];

  for (const machine of machines) {
    const appPwd = SSH_PASSWORDS[machine.tenancy] || Object.values(SSH_PASSWORDS)[0];
    const CMD = buildReleasesCmd(machine.ambiente);
    const mBal = getBalForEnv(machine.ambiente);
    try {
      const raw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: CMD, isStream: false, onData: null, timeout: 35000, res: null });
      const products = parseReleasesOutput(raw);
      results.push({ hostname: machine.hostname, ambiente: machine.ambiente, ip: machine.ip, success: true, products });
    } catch (e) {
      results.push({ hostname: machine.hostname, ambiente: machine.ambiente, ip: machine.ip, success: false, error: e.message, products: {} });
    }
  }

  res.json({ success: true, results });
});

// ─── Update Version XML via SSH chain: BAL → APP Machine ──────────────────────
app.post('/api/batch-update', async (req, res) => {
  const { balHost, balTenancy, machines, updates, bals } = req.body;
  if (!balHost || !machines || !machines.length || !updates || !updates.length) {
    return res.status(400).send('Faltam parâmetros.');
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];
  if (!balPassword) {
    return res.status(500).send('Senha do BAL não configurada.');
  }

  // Set headers for streaming
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  let isCancelled = false;
  req.on('close', () => { isCancelled = true; });

  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: balPassword };
  };

  function sshChainExecStream(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, onData, timeout = 15000) {
    return new Promise((resolve, reject) => {
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
            soulClient.exec(cmd, (err2, s) => {
              if (err2) {
                clearTimeout(timer); soulClient.end(); jumpClient.end();
                if (!settled) { settled = true; reject(err2); }
                return;
              }
              s.on('data', d => { if (onData) onData(d.toString()); });
              s.stderr.on('data', d => { if (onData) onData(d.toString()); });
              s.on('close', () => {
                clearTimeout(timer); soulClient.end(); jumpClient.end();
                if (!settled) { settled = true; resolve(); }
              });
            });
          });
          soulClient.on('error', err3 => {
            clearTimeout(timer); jumpClient.end();
            if (!settled) { settled = true; reject(err3); }
          });
          soulClient.connect({ sock: stream, username: SSH_USER, password: soulPwd, readyTimeout: 7500 });
        });
      });
      jumpClient.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });
      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 6000 });
    });
  }

  // Construir bash loop
  let cmdParts = [];
  cmdParts.push(`sudo su << 'EOF'
DATE_STR=$(date +"%d_%m_%Y_%H_%M_%S")
BACKUP_BASE="/MV/flowtiequalizer"
BACKUP_DIR="$BACKUP_BASE/\${DATE_STR}"
mkdir -p "$BACKUP_DIR"
echo ">> Diretório de backup criado: $BACKUP_DIR"
  `);

  for (const upd of updates) {
    cmdParts.push(`
echo "----------------------------------------"
echo "Processando produto: ${upd.produto} -> Alvo: ${upd.novaVersao}"
for xml in /MV/servers/*/*/conf/Catalina/localhost/${upd.produto}.xml; do
  if [ -f "$xml" ]; then
    # Derivar o ambiente pelo caminho do xml (soulmv_prd ou soulmv_trn)
    server_dir=$(echo "$xml" | awk -F'/' '{print $4}')
    if echo "$server_dir" | grep -qi "prd"; then
      APP_BASE="/MV/apps/soulmv_prd/products"
    else
      APP_BASE="/MV/apps/soulmv_trn/products"
    fi

    # Verificar se a pasta da release realmente existe no caminho correto
    if [ ! -d "$APP_BASE/${upd.produto}/${upd.novaVersao}" ]; then
      echo "❌ A release ${upd.novaVersao} NÃO EXISTE em $APP_BASE/${upd.produto}/ para o produto ${upd.produto}. Ignorando!"
      continue
    fi

    # Extrair nome do tomcat da string de path
    tomcat_name=$(echo "$xml" | awk -F'/' '{print $5}')
    
    # Criar subpasta pro tomcat dentro da pasta do dia
    mkdir -p "$BACKUP_DIR/$tomcat_name"
    
    # Create backup
    cp "$xml" "$BACKUP_DIR/$tomcat_name/$(basename "$xml")"
    echo "Backup salvo: $BACKUP_DIR/$tomcat_name/$(basename "$xml")"
    
    versao=$(grep -oP 'docBase="[^"]*products/[^/]+/\\K[^/]+' "$xml" 2>/dev/null | head -1)
    if [ -z "$versao" ]; then
      versao=$(grep -oP '\\d{4}\\.\\d+\\.\\d+-[A-Z]+' "$xml" 2>/dev/null | head -1)
    fi
    if [ -n "$versao" ] && [ "$versao" != "${upd.novaVersao}" ]; then
      sed -i "s/$versao/${upd.novaVersao}/g" "$xml"
      echo "Atualizado $xml para ${upd.novaVersao}"
    else
      echo "Versão no XML já é a desejada ou formato desconhecido."
    fi
  fi
done
    `);
  }
  cmdParts.push(`EOF`);

  const CMD = cmdParts.join('\n');

  for (const machine of machines) {
    res.write(`\n=== Conectando na máquina: ${machine.hostname} (${machine.ambiente}) ===\n`);
    const soulPassword = SSH_PASSWORDS[machine.tenancy] || Object.values(SSH_PASSWORDS)[0];
    const mBal = getBalForEnv(machine.ambiente);
    try {
      await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: CMD, isStream: true, res: res, onData: (chunk) => {
        res.write(chunk);
      }});
      res.write(`=== Concluído na máquina: ${machine.hostname} ===\n`);
    } catch (e) {
      res.write(`ERRO/TIMEOUT na máquina ${machine.hostname}: ${e.message}\n`);
    }
  }

  res.end();
});



// ─── Query Client DB Version via SSH + Oracle Direct Connect ───────────────
app.post('/api/client-db-version', async (req, res) => {
  const { balHost, balTenancy, machines, bals } = req.body;
  if (!balHost || !machines || !machines.length) {
    return res.status(400).send('Faltam parâmetros.');
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];
  if (!balPassword) {
    return res.status(500).send('Senha do BAL não configurada.');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const getBalForEnv = (env) => {
    if (bals && bals.length) {
      const b = bals.find(x => x.ambiente === env);
      if (b && b.public_ip) return { host: b.public_ip, pass: SSH_PASSWORDS[b.tenancy] || Object.values(SSH_PASSWORDS)[0] };
    }
    return { host: balHost, pass: balPassword };
  };

  // Same sshChainExec as check-versions (exact copy)
  function sshChainExec(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, timeout = 15000) {
    return new Promise((resolve, reject) => {
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
              s.on('data', d => { output += d.toString(); });
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

          soulClient.connect({ sock: stream, username: SSH_USER, password: soulPwd, readyTimeout: 7500 });
        });
      });

      jumpClient.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });

      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 7500 });
    });
  }

  // Parse Java-style properties content
  function parseProperties(content) {
    const props = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      props[key] = val;
    }
    return props;
  }

  // Parse Oracle JDBC URL (supports simple, service, SID, and RAC DESCRIPTION formats)
  function parseOracleJdbc(url) {
    // Format: jdbc:oracle:thin:@//host:port/service
    let match = url.match(/@\/\/([^:]+):(\d+)\/(.+)/);
    if (match) return { host: match[1], port: parseInt(match[2]), service: match[3] };

    // Format: jdbc:oracle:thin:@(DESCRIPTION=...HOST=xxx...PORT=xxx...SERVICE_NAME=xxx...)
    match = url.match(/HOST=([^)]+)/);
    const portMatch = url.match(/PORT=(\d+)/);
    const serviceMatch = url.match(/SERVICE_NAME=([^)]+)/);
    if (match && portMatch && serviceMatch) {
      return { host: match[1], port: parseInt(portMatch[1]), service: serviceMatch[1] };
    }

    // Format: jdbc:oracle:thin:@host:port/service
    match = url.match(/@([^:(]+):(\d+)\/(.+)/);
    if (match) return { host: match[1], port: parseInt(match[2]), service: match[3] };

    // Format: jdbc:oracle:thin:@host:port:sid
    match = url.match(/@([^:(]+):(\d+):(.+)/);
    if (match) return { host: match[1], port: parseInt(match[2]), sid: match[3] };

    return null;
  }

  // Iterate per machine (same pattern as check-versions)
  const alreadyConnectedDb = {};

  for (const machine of machines) {
    const soulPassword = SSH_PASSWORDS[machine.tenancy] || Object.values(SSH_PASSWORDS)[0];
    const env = (machine.ambiente || '').toUpperCase();
    const targetDir = getTargetDir(machine.ambiente);

    res.write(`\n=== ${machine.hostname} (${env}) ===\n`);
    res.write(`[1/3] Conectando via SSH em ${machine.hostname} (${machine.ip})...\n`);

    // Build script to find config file using the version from Tomcat XML (same approach as check-versions)
    const extractCmd = `
for serverdir in /MV/servers/${targetDir}/; do
  [ -d "$serverdir" ] || continue
  for dir in "$serverdir"/*/; do
    [ -d "$dir" ] || continue
    lhpath="$dir/conf/Catalina/localhost"
    [ -d "$lhpath" ] || continue
    for xml in "$lhpath"/soul-product-forms.xml; do
      [ -f "$xml" ] || continue
      CURRENT_VER=$(grep -oP 'docBase="[^"]*products/soul-product-forms/\\K[^/"]+' "$xml" 2>/dev/null | head -1)
      if [ -n "$CURRENT_VER" ]; then
        for BASE_DIR in /MV/apps/${targetDir} /MV/apps/soulmv_sml /MV/apps/soulmv_tst; do
          for CONF_FILE in "application.config.properties" "db.properties"; do
            FULL_PATH="$BASE_DIR/products/soul-product-forms/$CURRENT_VER/conf/$CONF_FILE"
            if [ -f "$FULL_PATH" ]; then
              echo "FOUND_BASE=$BASE_DIR"
              echo "FOUND_VERSION=$CURRENT_VER"
              echo "FOUND_FILE=$CONF_FILE"
              echo "---PROPS_START---"
              cat "$FULL_PATH"
              echo ""
              echo "---PROPS_END---"
              exit 0
            fi
          done
        done
      fi
    done
  done
done
echo "NOT_FOUND"
`.trim();

    const mBal = getBalForEnv(machine.ambiente);
    try {
      const raw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: extractCmd, isStream: false, onData: null, timeout: 35000, res: null });

      if (raw.includes('NOT_FOUND') || !raw.trim()) {
        res.write(`⚠ Nenhum arquivo de configuração encontrado em ${machine.hostname}\n`);
        if (raw.trim() && raw.trim() !== 'NOT_FOUND') {
          res.write(`  Saída SSH: ${raw.trim()}\n`);
        }
        continue;
      }

      // Parse response
      const baseLine = raw.match(/FOUND_BASE=(.+)/);
      const versionLine = raw.match(/FOUND_VERSION=(.+)/);
      const fileLine = raw.match(/FOUND_FILE=(.+)/);
      const propsMatch = raw.match(/---PROPS_START---([\s\S]*?)---PROPS_END---/);

      if (!baseLine || !versionLine || !propsMatch) {
        res.write(`⚠ Resposta inesperada do SSH:\n`);
        res.write(`${raw}\n`);
        continue;
      }

      const foundBase = baseLine[1].trim();
      const foundVersion = versionLine[1].trim();
      const foundFile = fileLine ? fileLine[1].trim() : 'unknown';
      const propsContent = propsMatch[1];
      const props = parseProperties(propsContent);

      res.write(`✅ Arquivo encontrado!\n`);
      res.write(`   Base: ${foundBase}/products/soul-product-forms\n`);
      res.write(`   Versão: ${foundVersion}\n`);
      res.write(`   Arquivo: ${foundFile}\n\n`);

      // Extract DB credentials (support multiple property naming conventions)
      const dbUrl = props['connectionSettings.url'] || props['db.url'] || props['spring.datasource.url'] || props['datasource.url'] || props['jdbc.url'] || '';
      const dbUser = props['connectionSettings.user'] || props['connectionSettings.username'] || props['db.username'] || props['spring.datasource.username'] || props['datasource.username'] || props['jdbc.username'] || '';
      const dbPass = props['connectionSettings.password'] || props['db.password'] || props['spring.datasource.password'] || props['datasource.password'] || props['jdbc.password'] || '';

      if (!dbUrl) {
        res.write(`⚠ Não encontrou URL de conexão nas propriedades.\n`);
        res.write(`  Chaves encontradas: ${Object.keys(props).join(', ')}\n`);
        res.write(`\n--- Conteúdo completo do arquivo ---\n${propsContent}\n---\n`);
        continue;
      }

      res.write(`[2/3] Credenciais extraídas:\n`);
      res.write(`   URL: ${dbUrl}\n`);
      res.write(`   Usuário: ${dbUser}\n`);
      res.write(`   Senha: ${'*'.repeat(Math.min(dbPass.length, 8))}...\n\n`);

      const oraConn = parseOracleJdbc(dbUrl);
      if (!oraConn) {
        res.write(`⚠ Não foi possível fazer parse da URL JDBC: ${dbUrl}\n`);
        continue;
      }

      res.write(`   Oracle Host: ${oraConn.host}\n`);
      res.write(`   Oracle Port: ${oraConn.port}\n`);
      res.write(`   Oracle ${oraConn.service ? 'Service' : 'SID'}: ${oraConn.service || oraConn.sid}\n\n`);

      // Avoid connecting to the same Oracle DB twice (PRD and TST may share machines)
      const dbKey = `${oraConn.host}:${oraConn.port}/${oraConn.service || oraConn.sid}`;
      if (alreadyConnectedDb[dbKey]) {
        res.write(`ℹ Banco ${dbKey} já foi consultado acima. Pulando.\n`);
        continue;
      }
      alreadyConnectedDb[dbKey] = true;

      // Step 3: Query Oracle via sqlplus on the remote machine (it can reach the DB on the private network)
      res.write(`[3/3] Executando sqlplus na máquina remota para consultar o banco...\n`);

      const connectString = oraConn.service
        ? `${dbUser}/${dbPass}@${oraConn.host}:${oraConn.port}/${oraConn.service}`
        : `${dbUser}/${dbPass}@${oraConn.host}:${oraConn.port}/${oraConn.sid}`;

      // Use sqlplus with markup CSV for easy parsing, fallback to regular sqlplus
      const sqlCmd = `
export ORACLE_HOME=$(ls -d /u01/app/oracle/product/*/dbhome_1 2>/dev/null | head -1 || ls -d /opt/oracle/product/*/dbhome_1 2>/dev/null | head -1 || echo "")
if [ -z "$ORACLE_HOME" ]; then
  # Try to find sqlplus in PATH or common locations
  SQLPLUS=$(which sqlplus 2>/dev/null || ls /u01/app/oracle/product/*/dbhome_1/bin/sqlplus 2>/dev/null | head -1 || ls /opt/oracle/instantclient*/sqlplus 2>/dev/null | head -1 || echo "")
else
  export PATH=$ORACLE_HOME/bin:$PATH
  export LD_LIBRARY_PATH=$ORACLE_HOME/lib:$LD_LIBRARY_PATH
  SQLPLUS=sqlplus
fi

if [ -z "$SQLPLUS" ] && ! command -v sqlplus &>/dev/null; then
  echo "SQLPLUS_NOT_FOUND"
  exit 0
fi

echo "---SQL_START---"
$SQLPLUS -S "${connectString}" <<EOSQL
SET PAGESIZE 0
SET LINESIZE 1000
SET FEEDBACK OFF
SET HEADING ON
SET COLSEP '|'
SET TRIMSPOOL ON
SET TRIMOUT ON
COLUMN CD_VERSAO FORMAT 99999999
COLUMN DS_VERSAO FORMAT A40
COLUMN DT_VERSAO FORMAT A22
COLUMN DS_RELEASE FORMAT A30
COLUMN SN_ATIVO FORMAT A5
SELECT * FROM dbamv.gcm_versao;
EXIT;
EOSQL
echo ""
echo "---SQL_END---"
`.trim();

      try {
        const sqlRaw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: sqlCmd, isStream: false, onData: null, timeout: 60000, res: null });

        if (sqlRaw.includes('SQLPLUS_NOT_FOUND')) {
          res.write(`⚠ sqlplus não encontrado na máquina ${machine.hostname}.\n`);
          res.write(`   💡 A máquina pode não ter o Oracle Client instalado.\n`);
          continue;
        }

        const sqlMatch = sqlRaw.match(/---SQL_START---([\s\S]*?)---SQL_END---/);
        if (!sqlMatch) {
          res.write(`⚠ Resposta inesperada do sqlplus:\n${sqlRaw}\n`);
          continue;
        }

        const sqlOutput = sqlMatch[1].trim();

        // Check for Oracle errors
        if (sqlOutput.includes('ORA-') || sqlOutput.includes('SP2-')) {
          res.write(`❌ Erro Oracle:\n${sqlOutput}\n`);
          continue;
        }

        if (!sqlOutput || sqlOutput.length < 5) {
          res.write(`⚠ Nenhum dado retornado do banco.\n`);
          continue;
        }

        res.write(`✅ Consulta executada com sucesso!\n\n`);
        res.write(`📋 Resultado gcm_versao:\n\n`);
        res.write(sqlOutput + '\n');

      } catch (sqlErr) {
        res.write(`❌ Erro ao executar sqlplus via SSH: ${sqlErr.message}\n`);
      }

    } catch (sshErr) {
      res.write(`❌ Erro SSH em ${machine.hostname}: ${sshErr.message}\n`);
    }
  }

  res.end();
});


// ─── WebSocket SSH Terminal ───────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] New WebSocket connection');
  let sshClient = null;
  let stream = null;

  ws.send(JSON.stringify({ type: 'log', msg: '🔌 WebSocket conectado ao servidor.' }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // ── Connect command ──
    if (msg.type === 'connect') {
      const { host, tenancy, hostname, dns, public_ip } = msg;
      const primaryPwd = SSH_PASSWORDS[tenancy] || msg.password || '';
      // All passwords to try (primary first, then the other one)
      const allPwds = Object.values(SSH_PASSWORDS).filter(Boolean);
      const passwordQueue = primaryPwd
        ? [primaryPwd, ...allPwds.filter(p => p !== primaryPwd)]
        : allPwds;
      // Hosts to try: Public IP first, then Private IP, then DNS
      const hostQueue = [];
      if (public_ip && public_ip !== '---') hostQueue.push(public_ip);
      if (host && !hostQueue.includes(host)) hostQueue.push(host);
      if (dns && !hostQueue.includes(dns)) hostQueue.push(dns);

      let attemptIndex = 0;
      let hostIndex = 0;

      function tryConnect() {
        if (hostIndex >= hostQueue.length) {
          ws.send(JSON.stringify({
            type: 'error',
            msg: `❌ Falha em todas as tentativas para ${hostname}. Verifique acesso de rede.`,
          }));
          ws.send(JSON.stringify({ type: 'disconnected' }));
          return;
        }

        const currentHost = hostQueue[hostIndex];
        const currentPwd = passwordQueue[attemptIndex % passwordQueue.length];
        const pwdLabel = Object.entries(SSH_PASSWORDS).find(([, v]) => v === currentPwd)?.[0] || 'custom';

        ws.send(JSON.stringify({
          type: 'log',
          msg: `🔄 Tentativa ${attemptIndex + 1}: ${currentHost} | Tenancy: ${pwdLabel} | Usuário: ${SSH_USER}`,
        }));

        if (sshClient) { try { sshClient.end(); } catch { } }
        sshClient = new Client();

        sshClient.on('ready', () => {
          ws.send(JSON.stringify({
            type: 'log',
            msg: `✅ SSH autenticado em ${hostname} (${currentHost}) com senha [${pwdLabel}]!`,
          }));

          sshClient.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, sh) => {
            if (err) {
              ws.send(JSON.stringify({
                type: 'error',
                msg: `❌ Erro ao abrir shell: ${err.message}`,
              }));
              sshClient.end();
              return;
            }

            stream = sh;
            ws.send(JSON.stringify({ type: 'connected', hostname }));

            stream.on('data', (chunk) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'data', data: chunk.toString('binary') }));
              }
            });

            stream.stderr.on('data', (chunk) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'data', data: chunk.toString('binary') }));
              }
            });

            stream.on('close', () => {
              ws.send(JSON.stringify({ type: 'log', msg: `🔌 Sessão SSH encerrada.` }));
              ws.send(JSON.stringify({ type: 'disconnected' }));
              sshClient.end();
            });
          });
        });

        sshClient.on('error', (err) => {
          const errMsg = err.message || '';
          const isAuthErr = errMsg.toLowerCase().includes('auth') || errMsg.includes('ECONNREFUSED') === false && errMsg.includes('authentication');
          const isTimeoutErr = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('timed out');
          const isNetErr = errMsg.includes('ECONNREFUSED') || errMsg.includes('EHOSTUNREACH') || errMsg.includes('ENOTFOUND');

          console.log(`[SSH] Error on ${currentHost} (pwd:${pwdLabel}): ${errMsg}`);

          if (isAuthErr && attemptIndex + 1 < passwordQueue.length) {
            // Auth failed → try next password, same host
            ws.send(JSON.stringify({
              type: 'log',
              msg: `⚠️ Senha incorreta [${pwdLabel}] – tentando próxima senha...`,
            }));
            attemptIndex++;
            setTimeout(tryConnect, 400);
          } else if ((isNetErr || isTimeoutErr) && hostIndex + 1 < hostQueue.length) {
            // Network issue → try next host
            ws.send(JSON.stringify({
              type: 'log',
              msg: `⚠️ Sem acesso via ${currentHost} – tentando ${hostQueue[hostIndex + 1]}...`,
            }));
            hostIndex++;
            attemptIndex = 0;
            setTimeout(tryConnect, 400);
          } else {
            // All options exhausted
            ws.send(JSON.stringify({
              type: 'error',
              msg: `❌ ${hostname}: ${errMsg}`,
            }));
            ws.send(JSON.stringify({ type: 'disconnected' }));
          }
        });

        sshClient.on('close', () => {
          // only emit disconnected if no retry is scheduled
        });

        sshClient.connect({
          host: currentHost,
          port: 22,
          username: SSH_USER,
          password: currentPwd,
          readyTimeout: 6000,
          keepaliveInterval: 10000,
        });
      }

      tryConnect();
      return;
    }

    // ── Input (keypress from terminal) ──
    if (msg.type === 'input' && stream) {
      stream.write(msg.data);
      return;
    }

    // ── Resize ──
    if (msg.type === 'resize' && stream) {
      stream.setWindow(msg.rows, msg.cols, 0, 0);
      return;
    }

    // ── Disconnect ──
    if (msg.type === 'disconnect') {
      if (stream) stream.end();
      if (sshClient) sshClient.end();
      ws.send(JSON.stringify({ type: 'log', msg: '🔌 Desconectado.' }));
      return;
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    if (stream) stream.destroy();
    if (sshClient) sshClient.end();
  });

  ws.on('error', (e) => {
    console.error('[WS] Error:', e.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ FlowtiEqualizerOps running at http://localhost:${PORT}`);
  console.log(`📂 Serving files from: ${__dirname}`);
  console.log(`📋 Inventory: ${inventory.length} unique machines loaded\n`);
  // Try DB in background
  getDB().catch(() => { });
});



