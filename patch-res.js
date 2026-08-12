const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/await executeWithBalFallback\(\{ bals, balHost, balTenancy, targetMachine: machine, cmd: CMD, isStream: true, onData: \(chunk\) => \{/g, 
  `await executeWithBalFallback({ bals, balHost, balTenancy, targetMachine: machine, cmd: CMD, isStream: true, res: res, onData: (chunk) => {`
);

fs.writeFileSync('server.js', code);
console.log('Fixed res in batch-update');
