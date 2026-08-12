const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
code = code.replace('\\n// ─── Helpers', '// ─── Helpers');
fs.writeFileSync('server.js', code);
console.log('Fixed syntax error');
