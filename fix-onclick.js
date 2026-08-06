const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');
// Add single quotes around ${machineJson} in the onclick
html = html.replace(
  /trocarVersaoTST\(\$\{machineJson\},/g,
  "trocarVersaoTST('${machineJson}',"
);
fs.writeFileSync('index.html', html, 'utf8');
console.log('Done. Occurrences fixed:', (html.match(/trocarVersaoTST\('\$\{machineJson\}'/g) || []).length);
