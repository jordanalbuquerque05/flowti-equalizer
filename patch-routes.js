const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Replace inner sshChainExec declarations (we can just comment them out or delete them, but simpler to just replace the calls)

const replacements = [
  {
    find: /const raw = await sshChainExec\(mBal\.host, mBal\.pass, machine\.ip, soulPassword, dynamicCMD\);/g,
    replace: `const raw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: dynamicCMD, isStream: false, onData: null, timeout: 35000, res: null });`
  },
  {
    find: /const raw = await sshChainExec\(mBal\.host, mBal\.pass, machine\.ip, appPwd, CMD\);/g,
    replace: `const raw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: CMD, isStream: false, onData: null, timeout: 35000, res: null });`
  },
  {
    find: /await sshChainExecStream\(mBal\.host, mBal\.pass, machine\.ip, soulPassword, CMD, \(chunk\) => \{/g,
    replace: `await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: CMD, isStream: true, onData: (chunk) => {`
  },
  {
    find: /const raw = await sshChainExec\(mBal\.host, mBal\.pass, machine\.ip, soulPassword, extractCmd\);/g,
    replace: `const raw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: extractCmd, isStream: false, onData: null, timeout: 35000, res: null });`
  },
  {
    find: /const sqlRaw = await sshChainExec\(balHost, balPassword, machine\.ip, soulPassword, sqlCmd, 60000\);/g,
    replace: `const sqlRaw = await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: sqlCmd, isStream: false, onData: null, timeout: 60000, res: null });`
  }
];

let changed = false;
for (const rep of replacements) {
  const match = code.match(rep.find);
  if (match) {
    code = code.replace(rep.find, rep.replace);
    console.log('Replaced', match.length, 'occurrences for:', rep.find);
    changed = true;
  } else {
    console.log('NOT FOUND:', rep.find);
  }
}

if (changed) {
  fs.writeFileSync('server.js', code);
  console.log('Routes patched');
}
