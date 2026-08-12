const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/require\('\.\/server\.js'\)\.SSH_PASSWORDS \|\| \{\}/g, 'SSH_PASSWORDS');

fs.writeFileSync('server.js', code);
console.log('Fixed SSH_PASSWORDS scope');
