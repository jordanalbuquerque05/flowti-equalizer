const fs = require('fs');

let serverCode = fs.readFileSync('server.js', 'utf8');

const target1 = `  let machines = getBALsFromInventory(codigo);

  // If nothing found in JSON, try DB
  if (machines.length === 0) {
    console.log(\`[API] "\${codigo}" not in JSON, trying DB...\`);
    machines = await getBALsFromDB(codigo);
  }`;

const replacement1 = `  let machines = getBALsFromInventory(codigo);

  // Always check DB and merge
  const dbMachines = await getBALsFromDB(codigo);
  if (dbMachines && dbMachines.length > 0) {
    machines = dedupMachines(machines.concat(dbMachines));
  }`;

const target2 = `    // Se não achou na memória, tenta no BD (se disponível)
    if (soulMachines.length === 0 || bals.length === 0) {
      const pool = await getDB();
      if (pool) {
        const padded = codigo.replace(/^0+/, '').padStart(4, '0');

        if (soulMachines.length === 0) {
          const [soulRows] = await pool.query(
            \`SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
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
             ORDER BY hostname\`,
            [codigo, padded]
          );
          soulMachines = soulRows.map(m => ({
            ...m,
            ambiente: getEnvLabel(m.hostname),
            sshPassword: SSH_PASSWORDS[m.tenancy] || '',
          }));
        }

        if (bals.length === 0) {
          const [balRows] = await pool.query(
            \`SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
             FROM instances
             WHERE (client_code = ? OR client_code = ?)
               AND UPPER(hostname) LIKE '%BAL%'
               AND public_ip IS NOT NULL AND public_ip != '---'
             ORDER BY hostname\`,
            [codigo, padded]
          );
          bals = balRows.map(m => ({
            ...m,
            ambiente: getEnvLabel(m.hostname),
            sshPassword: SSH_PASSWORDS[m.tenancy] || '',
          }));
        }
      }
    }`;

const replacement2 = `    // Sempre busca no BD e mescla com a memória
    const pool = await getDB();
    if (pool) {
      const padded = codigo.replace(/^0+/, '').padStart(4, '0');

      const [soulRows] = await pool.query(
        \`SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
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
         ORDER BY hostname\`,
        [codigo, padded]
      );
      const dbSoul = soulRows.map(m => ({
        ...m,
        ambiente: getEnvLabel(m.hostname),
        sshPassword: SSH_PASSWORDS[m.tenancy] || '',
      }));
      soulMachines = dedupMachines(soulMachines.concat(dbSoul));

      const [balRows] = await pool.query(
        \`SELECT hostname, private_ip AS ip, public_ip, client_code AS codigo, tenancy_name AS tenancy
         FROM instances
         WHERE (client_code = ? OR client_code = ?)
           AND UPPER(hostname) LIKE '%BAL%'
           AND public_ip IS NOT NULL AND public_ip != '---'
         ORDER BY hostname\`,
        [codigo, padded]
      );
      const dbBals = balRows.map(m => ({
        ...m,
        ambiente: getEnvLabel(m.hostname),
        sshPassword: SSH_PASSWORDS[m.tenancy] || '',
      }));
      bals = dedupMachines(bals.concat(dbBals));
    }`;

if (!serverCode.includes(target1)) {
  console.log('target1 NOT FOUND');
} else {
  serverCode = serverCode.replace(target1, replacement1);
  console.log('target1 applied');
}

if (!serverCode.includes(target2)) {
  console.log('target2 NOT FOUND');
} else {
  serverCode = serverCode.replace(target2, replacement2);
  console.log('target2 applied');
}

fs.writeFileSync('server.js', serverCode);
