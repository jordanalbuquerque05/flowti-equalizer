const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('ssh2');

const INVENTORY_PATH = path.join(__dirname, 'inventario_geral_maquinas.json');
const REPORT_PATH = path.join(__dirname, 'relatorio_dns_bals.md');

const SSH_USER = 'mv-portal';
const SSH_PASSWORDS = {
  MVCLIENTESAAS: 'MvMv@@2019-9102',
  CLOUDMVORACLE: 'MvMv@@20192019',
};

const DB_CONFIG = {
  host: '137.131.181.89',
  port: 33060,
  database: 'oci_inventory',
  user: 'user_read_portal',
  password: 'FlowtiOci2025*',
  connectTimeout: 10000,
};

async function getPublicIps(hostnames) {
  try {
    const pool = await mysql.createPool(DB_CONFIG);
    const [rows] = await pool.query(
      `SELECT hostname, public_ip FROM instances WHERE hostname IN (?)`,
      [hostnames]
    );
    await pool.end();
    
    const map = {};
    for (const r of rows) {
      if (r.public_ip && r.public_ip !== '---') {
        map[r.hostname] = r.public_ip;
      }
    }
    return map;
  } catch (e) {
    console.error('Failed to get public IPs:', e.message);
    return {};
  }
}

function checkMachineDns(machine) {
  return new Promise((resolve) => {
    const client = new Client();
    let output = '';
    
    const host = machine.public_ip || machine.ip;
    const tenancy = machine.tenancy;
    const pwd = SSH_PASSWORDS[tenancy] || machine.senha || SSH_PASSWORDS['CLOUDMVORACLE'];
    
    const cleanup = () => {
      client.end();
    };
    
    client.on('ready', () => {
      client.exec('cat /etc/httpd/conf.d/welcome.conf', (err, stream) => {
        if (err) {
          cleanup();
          return resolve({ success: false, error: 'Failed to execute command: ' + err.message });
        }
        
        stream.on('data', (data) => {
          output += data.toString();
        }).on('close', (code, signal) => {
          cleanup();
          
          if (code !== 0) {
            return resolve({ success: false, error: 'File probably not found or access denied, code: ' + code });
          }
          
          // Parse DNS
          // Look for ServerName or ServerAlias
          let foundDns = null;
          const lines = output.split('\n');
          for (const line of lines) {
            const match = line.match(/^\s*Server(?:Name|Alias)\s+([^\s]+)/i);
            if (match && match[1].includes('.cloudmv.com.br')) {
              foundDns = match[1].trim();
              break;
            }
          }
          
          if (!foundDns) {
             for (const line of lines) {
               const match = line.match(/^\s*Server(?:Name|Alias)\s+([^\s]+)/i);
               if (match) {
                 foundDns = match[1].trim();
                 break;
               }
             }
          }
          
          resolve({ success: true, dns: foundDns, fileContentLength: output.length });
        }).stderr.on('data', (data) => {
          // ignore stderr unless it crashes
        });
      });
    }).on('error', (err) => {
      resolve({ success: false, error: 'Connection error: ' + err.message });
    }).on('timeout', () => {
       resolve({ success: false, error: 'Connection timeout' });
    });
    
    client.connect({
      host: host,
      port: 22,
      username: SSH_USER,
      password: pwd,
      readyTimeout: 10000, // 10s timeout
    });
  });
}

async function main() {
  console.log('Loading inventory...');
  let inventory = [];
  try {
    inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  } catch(e) {
    console.error('Error loading inventory', e);
    process.exit(1);
  }
  
  const bals = inventory.filter(m => m.hostname && /BAL/i.test(m.hostname));
  console.log(`Found ${bals.length} BAL machines in inventory.`);
  
  console.log('Fetching public IPs from DB...');
  const hostnames = bals.map(m => m.hostname);
  
  // Chunking for query size limits just in case
  const pubIpMap = {};
  const chunkSize = 200;
  for (let i = 0; i < hostnames.length; i += chunkSize) {
    const chunk = hostnames.slice(i, i + chunkSize);
    const mapChunk = await getPublicIps(chunk);
    Object.assign(pubIpMap, mapChunk);
  }
  console.log(`Found ${Object.keys(pubIpMap).length} public IPs.`);
  
  for (const m of bals) {
    if (pubIpMap[m.hostname]) {
      m.public_ip = pubIpMap[m.hostname];
    }
  }
  
  console.log('Starting SSH audits...');
  const results = {
    updated: [],
    matched: [],
    failed: []
  };
  
  let changesMade = 0;
  
  // Process in batches of 10 to avoid too many concurrent connections
  const CONCURRENCY = 10;
  for (let i = 0; i < bals.length; i += CONCURRENCY) {
    const batch = bals.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (machine) => {
      console.log(`[${machine.hostname}] Checking...`);
      const res = await checkMachineDns(machine);
      
      if (!res.success) {
        console.log(`[${machine.hostname}] Failed: ${res.error}`);
        results.failed.push({ host: machine.hostname, error: res.error });
        return;
      }
      
      const currentDns = machine.dns || '';
      const newDns = res.dns || '';
      
      if (!newDns) {
        console.log(`[${machine.hostname}] No ServerName/ServerAlias found in config.`);
        results.failed.push({ host: machine.hostname, error: 'No DNS found in config' });
        return;
      }
      
      if (currentDns !== newDns) {
        console.log(`[${machine.hostname}] UPDATING DNS: ${currentDns} -> ${newDns}`);
        machine.dns = newDns;
        results.updated.push({ host: machine.hostname, old: currentDns, new: newDns });
        changesMade++;
      } else {
        console.log(`[${machine.hostname}] Matches: ${currentDns}`);
        results.matched.push({ host: machine.hostname, dns: currentDns });
      }
    });
    
    await Promise.all(promises);
  }
  
  console.log('Audit complete.');
  
  if (changesMade > 0) {
    console.log(`Saving ${changesMade} changes to inventory...`);
    // Note: since objects are passed by reference, updating bals updates inventory
    fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2));
    console.log('Inventory saved.');
  } else {
    console.log('No changes were necessary.');
  }
  
  console.log('Generating report...');
  
  let md = `# Relatório de Auditoria de DNS (Máquinas BAL)\n\n`;
  md += `**Total de Máquinas BAL avaliadas:** ${bals.length}\n`;
  md += `**Atualizadas:** ${results.updated.length}\n`;
  md += `**Mantidas (Já corretas):** ${results.matched.length}\n`;
  md += `**Falharam (Timeout, Senha errada, Sem arquivo):** ${results.failed.length}\n\n`;
  
  md += `## Máquinas Atualizadas\n`;
  if (results.updated.length > 0) {
    for (const u of results.updated) {
      md += `- **${u.host}**: de \`${u.old}\` para \`${u.new}\`\n`;
    }
  } else {
    md += `*Nenhuma máquina precisou ser atualizada.*\n`;
  }
  
  md += `\n## Máquinas Corretas\n`;
  if (results.matched.length > 0) {
    for (const m of results.matched) {
      md += `- **${m.host}**: \`${m.dns}\`\n`;
    }
  } else {
    md += `*Nenhuma máquina estava 100% correta.*\n`;
  }
  
  md += `\n## Falhas / Não acessíveis\n`;
  if (results.failed.length > 0) {
    for (const f of results.failed) {
      md += `- **${f.host}**: ${f.error}\n`;
    }
  } else {
    md += `*Nenhuma falha ocorreu.*\n`;
  }
  
  fs.writeFileSync(REPORT_PATH, md);
  console.log(`Report generated at ${REPORT_PATH}`);
}

main().catch(console.error);
