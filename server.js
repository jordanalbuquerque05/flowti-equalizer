const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = 3000;

require('dotenv').config();

const DB_CONFIG = {
  host: process.env.DB_HOST || '137.131.181.89',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 33060,
  database: process.env.DB_NAME || 'oci_inventory',
  user: process.env.DB_USER || 'user_read_portal',
  password: process.env.DB_PASSWORD,
  connectTimeout: 10000,
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
    const key = m.hostname ? m.hostname.toUpperCase() : null;
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

function getBALsFromInventory(codigoSearch) {
  const search = codigoSearch.trim().toLowerCase();
  return inventory
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
    return [];
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));

// List all clients with at least one BAL
app.get('/api/clients', (req, res) => {
  const clients = getAllClientsFromInventory();
  res.json({ success: true, data: clients, count: clients.length });
});

// Endpoint para reiniciar o tomcat
app.post('/api/restart-tomcat', async (req, res) => {
  const { hostnames, targetEnv, produto, balHost, balTenancy } = req.body;
  
  if (!hostnames || !hostnames.length || !targetEnv || !produto || !balHost || !balTenancy) {
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
    
    // Comando para procurar o xml do produto e achar o nome do tomcat
    const cmd = `sudo su << 'EOF'
xml=$(ls /MV/servers/*/*/conf/Catalina/localhost/${produto}.xml 2>/dev/null | head -1)
if [ -z "$xml" ]; then
  echo "❌ Produto ${produto} não encontrado na máquina ${machine.hostname}"
else
  tomcat_name=$(echo "$xml" | awk -F'/' '{print $5}')
  tomcat_port=$(echo "$tomcat_name" | grep -oP '\\d+')
  echo ">> Produto ${produto} pertence ao Tomcat: $tomcat_name (porta: $tomcat_port)"

  echo ">> [1/3] Executando: tomcatctl stop $tomcat_port"
  tomcatctl stop "$tomcat_port"
  if [ $? -ne 0 ]; then
    echo "❌ STOP falhou para o Tomcat $tomcat_port — abortando sequência."
    exit 1
  fi
  echo "✅ STOP concluído."

  echo ">> [2/3] Executando: tomcatctl cleanup $tomcat_port"
  tomcatctl cleanup "$tomcat_port"
  if [ $? -ne 0 ]; then
    echo "❌ CLEANUP falhou para o Tomcat $tomcat_port — abortando sequência."
    exit 1
  fi
  echo "✅ CLEANUP concluído."

  echo ">> [3/3] Executando: tomcatctl start $tomcat_port"
  tomcatctl start "$tomcat_port"
  if [ $? -ne 0 ]; then
    echo "❌ START falhou para o Tomcat $tomcat_port"
    exit 1
  fi
  echo "✅ START concluído."
  echo "=== Tomcat $tomcat_port reiniciado com sucesso na máquina ${machine.hostname} ==="
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
            soulClient.connect({ sock: stream, username: SSH_USER, password: soulPassword, readyTimeout: 15000 });
          });
        });
        jumpClient.on('error', err => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(err); }
        });
        jumpClient.connect({ host: balHost, port: 22, username: SSH_USER, password: balPassword, readyTimeout: 12000 });
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

    const cmd = `sudo su << 'EOF'
xml=$(ls /MV/servers/*/*/conf/Catalina/localhost/${produto}.xml 2>/dev/null | head -1)
if [ -z "$xml" ]; then
  echo "\u274c Produto ${produto} não encontrado na máquina ${machine.hostname}"
else
  tomcat_name=$(echo "$xml" | awk -F'/' '{print $5}')
  backup_file="${backupPath}/$tomcat_name/$(basename "$xml")"
  
  if [ -f "$backup_file" ]; then
    echo ">> Restaurando backup de $backup_file para $xml"
    cp "$backup_file" "$xml"
    if [ $? -eq 0 ]; then
      echo "=== Rollback do produto ${produto} concluído com sucesso! ==="
    else
      echo "\u274c Erro ao copiar o arquivo de backup."
    fi
  else
    echo "\u274c Arquivo de backup não encontrado: $backup_file"
  fi
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
            soulClient.connect({ sock: stream, username: SSH_USER, password: soulPassword, readyTimeout: 15000 });
          });
        });
        jumpClient.on('error', err => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(err); }
        });
        jumpClient.connect({ host: balHost, port: 22, username: SSH_USER, password: balPassword, readyTimeout: 12000 });
      });
    } catch (err) {
      res.write(`❌ Erro no rollback via SSH: ${err.message}\n`);
    }
  }

  res.write(`\n✅ Processo de rollback concluído!\n`);
  res.end();
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

  // If nothing found in JSON, try DB
  if (machines.length === 0) {
    console.log(`[API] "${codigo}" not in JSON, trying DB...`);
    machines = await getBALsFromDB(codigo);
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
    const pool = await getDB();
    if (!pool) return res.status(503).json({ success: false, error: 'DB not available' });

    const padded = codigo.replace(/^0+/, '').padStart(4, '0');

    // Get APP machines (SOUL, ERP, HOSP, REPORT, PEP, INTEGRACAO)
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

    // Get BAL machines (for jump host)
    const [balRows] = await pool.query(
      `SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
       FROM instances
       WHERE (client_code = ? OR client_code = ?)
         AND UPPER(hostname) LIKE '%BAL%'
         AND public_ip IS NOT NULL AND public_ip != '---'
       ORDER BY hostname`,
      [codigo, padded]
    );

    // Enrich SOUL machines with ambiente label
    const soulMachines = soulRows.map(m => ({
      ...m,
      ambiente: getEnvLabel(m.hostname),
      sshPassword: SSH_PASSWORDS[m.tenancy] || '',
    }));

    const bals = balRows.map(m => ({
      ...m,
      ambiente: getEnvLabel(m.hostname),
      sshPassword: SSH_PASSWORDS[m.tenancy] || '',
    }));

    res.json({ success: true, soulMachines, bals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Check Versions via SSH chain: BAL → SOUL ─────────────────────────────────
app.post('/api/check-versions', async (req, res) => {
  const { balHost, balTenancy, machines } = req.body;
  if (!balHost || !machines || !machines.length) {
    return res.status(400).json({ success: false, error: 'Missing balHost or machines' });
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];

  // Command executed on each APP machine — scans ALL /MV/servers/*/ subdirs
  const CMD = `
for serverdir in /MV/servers/*/; do
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

  function sshExec(host, password, cmd, timeout = 20000) {
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
          stream.stderr.on('data', () => {});
          stream.on('close', () => { clearTimeout(timer); client.end(); resolve(output); });
        });
      });

      client.on('error', err => { clearTimeout(timer); reject(err); });

      client.connect({ host, port: 22, username: SSH_USER, password, readyTimeout: 12000 });
    });
  }

  function sshChainExec(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, timeout = 30000) {
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
              s.stderr.on('data', () => {});
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

      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 12000 });
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
    try {
      const raw = await sshChainExec(balHost, balPassword, machine.ip, soulPassword, CMD);
      const tomcats = parseVersionOutput(raw);
      results.push({ hostname: machine.hostname, ambiente: machine.ambiente, ip: machine.ip, success: true, tomcats });
    } catch (e) {
      results.push({ hostname: machine.hostname, ambiente: machine.ambiente, ip: machine.ip, success: false, error: e.message, tomcats: {} });
    }
  }

  res.json({ success: true, results });
});

// ─── Check Available Releases via SSH chain: BAL → APP Machine ────────────────
app.post('/api/check-releases', async (req, res) => {
  const { balHost, balTenancy, machines } = req.body;
  if (!balHost || !machines || !machines.length) {
    return res.status(400).json({ success: false, error: 'Missing balHost or machines' });
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];

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

  function sshChainExec(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, timeout = 30000) {
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
              s.stderr.on('data', () => {});
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

      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 12000 });
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
    try {
      const raw = await sshChainExec(balHost, balPassword, machine.ip, appPwd, CMD);
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
  const { balHost, balTenancy, machines, updates } = req.body;
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

  function sshChainExecStream(balPubIp, balPwd, soulPrivIp, soulPwd, cmd, onData, timeout = 60000) {
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
          soulClient.connect({ sock: stream, username: SSH_USER, password: soulPwd, readyTimeout: 15000 });
        });
      });
      jumpClient.on('error', err => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(err); }
      });
      jumpClient.connect({ host: balPubIp, port: 22, username: SSH_USER, password: balPwd, readyTimeout: 12000 });
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
    try {
      await sshChainExecStream(balHost, balPassword, machine.ip, soulPassword, CMD, (chunk) => {
        res.write(chunk);
      });
      res.write(`=== Concluído na máquina: ${machine.hostname} ===\n`);
    } catch (e) {
      res.write(`ERRO/TIMEOUT na máquina ${machine.hostname}: ${e.message}\n`);
    }
  }

  res.end();
});



// ─── Query Client DB Version via SSH Tunnel ───────────────
app.post('/api/client-db-version', async (req, res) => {
  const { balHost, balTenancy, machines } = req.body;
  if (!balHost || !machines || !machines.length) {
    return res.status(400).send('Faltam parâmetros.');
  }

  const balPassword = SSH_PASSWORDS[balTenancy] || Object.values(SSH_PASSWORDS)[0];
  if (!balPassword) {
    return res.status(500).send('Senha do BAL não configurada.');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const environments = [...new Set(machines.map(m => m.ambiente.toUpperCase()))];
  const { exec } = require('child_process');
  const net = require('net');

  for (const env of environments) {
    res.write(`\n=== Ambiente: ${env} ===\n`);
    
    let envPattern = "soulmv_*";
    if (env === "PRD") envPattern = "soulmv_prd";
    if (env === "TST") envPattern = "soulmv_trn soulmv_sml soulmv_tst";

    // 1. Script para apenas extrair as propriedades
    const extractCmd = `sudo su << 'EOF'
VERSAO_OUT=$(versao 2>/dev/null)
CAS_LINE=$(echo "$VERSAO_OUT" | grep -i "mvautenticador-cas" | head -1)
RELEASE=$(echo "$CAS_LINE" | awk '{print $NF}')
if [ -z "$RELEASE" ]; then exit 1; fi

DB_PROPS=""
for dir in ${envPattern}; do
  FOUND=$(ls /MV/apps/$dir/products/mvautenticador-cas/$RELEASE/conf/db.properties 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    DB_PROPS="$FOUND"
    break
  fi
done

elif [[ "$DB_URL" == *"mysql"* ]]; then
  echo "Tipo: MYSQL"
  DB_HOST=$(echo "$DB_URL" | grep -oP '(?<=mysql://)([^:/]+)')
  DB_PORT=$(echo "$DB_URL" | grep -oP '(?<=:)\\d+(?=/)' | head -1)
  DB_PORT=\${DB_PORT:-3306}
  echo "Host/Porta: $DB_HOST:$DB_PORT"
  
  CONTAINER=$(docker ps --format "{{.Names}}" | grep -i -E 'mysql|db' | head -1)
  if [ -n "$CONTAINER" ]; then
    echo "Container Docker: $CONTAINER"
    docker exec "$CONTAINER" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" -e "$QUERY" 2>&1
  else
    echo "Container não encontrado, tentando CLI local..."
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASS" -e "$QUERY" 2>&1
  fi
else
  echo "ERRO: Tipo de banco não suportado ($DB_URL)"
  exit 1
fi
EOF
`;

    try {
      await sshExecStream(balHost, balPassword, CMD, (chunk) => {
        res.write(chunk);
      });
      res.write(`=== Fim: ${env} ===\\n`);
    } catch (e) {
      res.write(`ERRO no ambiente ${env}: ${e.message}\\n`);
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
        const currentPwd  = passwordQueue[attemptIndex % passwordQueue.length];
        const pwdLabel    = Object.entries(SSH_PASSWORDS).find(([,v]) => v === currentPwd)?.[0] || 'custom';

        ws.send(JSON.stringify({
          type: 'log',
          msg: `🔄 Tentativa ${attemptIndex + 1}: ${currentHost} | Tenancy: ${pwdLabel} | Usuário: ${SSH_USER}`,
        }));

        if (sshClient) { try { sshClient.end(); } catch {} }
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
          const isAuthErr    = errMsg.toLowerCase().includes('auth') || errMsg.includes('ECONNREFUSED') === false && errMsg.includes('authentication');
          const isTimeoutErr = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('timed out');
          const isNetErr     = errMsg.includes('ECONNREFUSED') || errMsg.includes('EHOSTUNREACH') || errMsg.includes('ENOTFOUND');

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
          readyTimeout: 12000,
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
server.listen(PORT, () => {
  console.log(`\n⚡ FlowtiEqualizerOps running at http://localhost:${PORT}`);
  console.log(`📂 Serving files from: ${__dirname}`);
  console.log(`📋 Inventory: ${inventory.length} unique machines loaded\n`);
  // Try DB in background
  getDB().catch(() => {});
});
