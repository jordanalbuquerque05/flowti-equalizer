const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// The file currently has lines 918-921:
//     } else {
//       res.write(`⚠️ tomcat-version.txt não encontrado no PRD, ignorando este passo.\n\n`);
//     }
// 
//           let tstErr = '';

// We need to insert PASSO 4 after line 920 and remove the garbage from 922 to 948.

let lines = code.split('\n');

const startIndex = lines.findIndex(l => l.includes('res.write(`⚠️ tomcat-version.txt não encontrado no PRD, ignorando este passo.\\n\\n`);')) + 2;
const endIndex = lines.findIndex(l => l.includes('// NOVO PASSO: Copiar conf da release anterior para a nova')) - 1;

if (startIndex < 2 || endIndex < 0) {
    console.log("Could not find indices");
    process.exit(1);
}

const passo4 = [
    "    // PASSO 4: SCP (Tar Pipe)",
    "    res.write(`>> [5/5] Sincronizando pasta 'forms' de PRD para TST (Pipe Direto)...\\n`);",
    "    ",
    "    if (skipFiles) {",
    "      res.write(`   ✅ Cópia de arquivos ignorada pelo usuário (arquivos já existem no disco).\\n\\n`);",
    "    } else {",
    "      console.log(`[SYNC] 5/5 - Sincronizando arquivos (tar pipe). Acompanhando logs de transferência...`);",
    "      const prdPath = `/MV/apps/soulmv_prd/products/${produto}/${release}`;",
    "      const tstPath = `/MV/apps/soulmv_trn/products/${produto}/${release}`;",
    "",
    "      await execCmd(tstSoulClient, `sudo su -c \"mkdir -p ${tstPath}\"`, 'TST-MKDIR');",
    "",
    "      if (forceOverwrite) {",
    "        res.write(`   - Removendo pastas 'forms' e 'uploadfiles' antigas em TST (forceOverwrite)...\\n`);",
    "        await execCmd(tstSoulClient, `sudo su -c \"rm -rf ${tstPath}/forms ${tstPath}/uploadfiles\"`, 'TST-RM-DIRS');",
    "        res.write(`   ✅ Pastas antigas removidas!\\n`);",
    "      }",
    "",
    "      res.write(`   - Compactando 'forms' e 'uploadfiles' (se existir) de PRD\\n`);",
    "      res.write(`   - Extraindo em ${tstPath}\\n`);",
    "",
    "      await new Promise((resolve, reject) => {",
    "        const tarCmd = `sudo su -c \"cd ${prdPath} && tar --exclude='forms/uploadfiles' -czf - \\\\$([ -d forms ] && echo forms) \\\\$([ -d uploadfiles ] && echo uploadfiles)\"`;",
    "        prdSoulClient.exec(tarCmd, (err, prdStream) => {",
    "          if (err) return reject(err);",
    "",
    "          prdStream.stderr.on('data', d => {",
    "            const str = d.toString();",
    "            const lines = str.split('\\n');",
    "            for (let l of lines) if (l.trim()) res.write(`   [PRD-TAR-ERRO] ${l.trim()}\\n`);",
    "          });",
    "",
    "          tstSoulClient.exec(`sudo su -c \"tar -xzvf - -C ${tstPath}\"`, (err2, tstStream) => {",
    "            if (err2) return reject(err2);",
    "",
    "            let tstErr = '';",
    "            tstStream.stderr.on('data', d => {",
    "              const str = d.toString();",
    "              tstErr += str;",
    "              const lines = str.split('\\n');",
    "              for (let l of lines) if (l.trim()) res.write(`   [TST-TAR] ${l.trim()}\\n`);",
    "            });",
    "",
    "            tstStream.on('data', d => {",
    "              const lines = d.toString().split('\\n');",
    "              for (let l of lines) if (l.trim()) res.write(`   [TST-TAR] ${l.trim()}\\n`);",
    "            });",
    "",
    "            prdStream.pipe(tstStream);",
    "",
    "            tstStream.on('close', (code) => {",
    "              if (code !== 0 && !tstErr.includes('forms/') && !tstErr.includes('uploadfiles/')) reject(new Error(tstErr || 'Erro no tar TST'));",
    "              else resolve();",
    "            });",
    "",
    "            prdStream.on('error', (e) => reject(e));",
    "            tstStream.on('error', (e) => reject(e));",
    "          });",
    "        });",
    "      });",
    "      res.write(`✅ Arquivos transferidos com sucesso!\\n\\n`);",
    "    }"
];

const newLines = [...lines.slice(0, startIndex), ...passo4, ...lines.slice(endIndex)];
fs.writeFileSync('server.js', newLines.join('\n'));
console.log("Successfully fixed server.js");
