const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

// The file has a botched PASSO 4 block and the newly inserted one inside the if block.
// I will just replace the entire region from line 910 to 1000 with the clean version.

let lines = code.split('\n');

// Find the start of PASSO 3
let startIdx = lines.findIndex(l => l.includes('PASSO 3: Copiar tomcat-version.txt'));
let endIdx = lines.findIndex(l => l.includes('NOVO PASSO: Copiar conf da release anterior para a nova'));

if (startIdx === -1 || endIdx === -1) {
  console.log("Not found");
  process.exit(1);
}

const replacement = [
  '    // PASSO 3: Copiar tomcat-version.txt',
  '    res.write(`>> [4/5] Copiando arquivo tomcat-version.txt do PRD...\\n`);',
  '    const cmd3 = `sudo su -c "cat /MV/servers/*/${prdTomcat}/conf/tomcat-version.txt 2>/dev/null || true"`;',
  '    const res3 = await execCmd(prdSoulClient, cmd3, \'PRD-READ-VERSION\');',
  '    let prdTomcatVersionTxt = res3.stdout;',
  '',
  '    if (prdTomcatVersionTxt) {',
  '      const b64 = Buffer.from(prdTomcatVersionTxt).toString(\'base64\');',
  '      const setVerCmd = `sudo su -c "sh -c \'for d in /MV/servers/*/${tstTomcat}/conf; do if [ -d \\"\\\\$d\\" ]; then echo \\"${b64}\\" | base64 -d > \\"\\\\$d/tomcat-version.txt\\"; fi; done\'"`;',
  '      const res4 = await execCmd(tstSoulClient, setVerCmd, \'TST-WRITE-VERSION\');',
  '      if (res4.code !== 0) throw new Error(res4.stderr || \'Erro ao escrever tomcat-version.txt no TST\');',
  '      res.write(`✅ tomcat-version.txt do TST atualizado com sucesso!\\n\\n`);',
  '    } else {',
  '      res.write(`⚠️ tomcat-version.txt não encontrado no PRD, ignorando este passo.\\n\\n`);',
  '    }',
  '',
  '    // PASSO 4: SCP (Tar Pipe)',
  '    res.write(`>> [5/5] Sincronizando pasta \\'forms\\' de PRD para TST (Pipe Direto)...\\n`);',
  '    ',
  '    if (skipFiles) {',
  '      res.write(`   ✅ Cópia de arquivos ignorada pelo usuário (arquivos já existem no disco).\\n\\n`);',
  '    } else {',
  '      console.log(`[SYNC] 5/5 - Sincronizando arquivos (tar pipe). Acompanhando logs de transferência...`);',
  '      const prdPath = `/MV/apps/soulmv_prd/products/${produto}/${release}`;',
  '      const tstPath = `/MV/apps/soulmv_trn/products/${produto}/${release}`;',
  '',
  '      await execCmd(tstSoulClient, `sudo su -c "mkdir -p ${tstPath}"`, \'TST-MKDIR\');',
  '',
  '      // Se o usuario confirmou sobrescrita, apaga a pasta forms antes de copiar',
  '      if (forceOverwrite) {',
  '        res.write(`   - Removendo pastas \\'forms\\' e \\'uploadfiles\\' antigas em TST (forceOverwrite)...\\n`);',
  '        await execCmd(tstSoulClient, `sudo su -c "rm -rf ${tstPath}/forms ${tstPath}/uploadfiles"`, \'TST-RM-DIRS\');',
  '        res.write(`   ✅ Pastas antigas removidas!\\n`);',
  '      }',
  '',
  '      res.write(`   - Compactando \\'forms\\' e \\'uploadfiles\\' (se existir) de PRD\\n`);',
  '      res.write(`   - Extraindo em ${tstPath}\\n`);',
  '',
  '      await new Promise((resolve, reject) => {',
  '        // Lista condicionalmente forms e uploadfiles para empacotar, ignorando uploadfiles dentro de forms',
  '        const tarCmd = `sudo su -c "cd ${prdPath} && tar --exclude=\\'forms/uploadfiles\\' -czf - \\\\$([ -d forms ] && echo forms) \\\\$([ -d uploadfiles ] && echo uploadfiles)"`;',
  '        prdSoulClient.exec(tarCmd, (err, prdStream) => {',
  '          if (err) return reject(err);',
  '',
  '          prdStream.stderr.on(\'data\', d => {',
  '            const str = d.toString();',
  '            const lines = str.split(\'\\n\');',
  '            for (let l of lines) if (l.trim()) res.write(`   [PRD-TAR-ERRO] ${l.trim()}\\n`);',
  '          });',
  '',
  '          tstSoulClient.exec(`sudo su -c "tar -xzvf - -C ${tstPath}"`, (err2, tstStream) => {',
  '            if (err2) return reject(err2);',
  '',
  '            let tstErr = \'\';',
  '            tstStream.stderr.on(\'data\', d => {',
  '              const str = d.toString();',
  '              tstErr += str;',
  '              const lines = str.split(\'\\n\');',
  '              for (let l of lines) if (l.trim()) res.write(`   [TST-TAR] ${l.trim()}\\n`);',
  '            });',
  '',
  '            tstStream.on(\'data\', d => {',
  '              const lines = d.toString().split(\'\\n\');',
  '              for (let l of lines) if (l.trim()) res.write(`   [TST-TAR] ${l.trim()}\\n`);',
  '            });',
  '',
  '            prdStream.pipe(tstStream);',
  '',
  '            tstStream.on(\'close\', (code) => {',
  '              if (code !== 0 && !tstErr.includes(\'forms/\') && !tstErr.includes(\'uploadfiles/\')) reject(new Error(tstErr || \'Erro no tar TST\'));',
  '              else resolve();',
  '            });',
  '',
  '            prdStream.on(\'error\', (e) => reject(e));',
  '            tstStream.on(\'error\', (e) => reject(e));',
  '          });',
  '        });',
  '      });',
  '',
  '      res.write(`✅ Arquivos transferidos com sucesso!\\n\\n`);',
  '    }',
  ''
];

const newLines = [...lines.slice(0, startIdx), ...replacement, ...lines.slice(endIdx)];

fs.writeFileSync('server.js', newLines.join('\n'));
console.log('Successfully fixed');
