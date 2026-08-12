const fs = require('fs');

let serverContent = fs.readFileSync('server.js', 'utf8');

// Replace uploadfiles mentions in server.js
serverContent = serverContent.replace(
  /tar --exclude='forms\/uploadfiles' -czf - \\$\(\[ -d forms \] && echo forms\) \\$\(\[ -d uploadfiles \] && echo uploadfiles\)/g,
  'tar -czf - \\$([ -d forms ] && echo forms)'
);

serverContent = serverContent.replace(
  /rm -rf \$\{tstPath\}\/forms \$\{tstPath\}\/uploadfiles/g,
  'rm -rf \${tstPath}/forms'
);

serverContent = serverContent.replace(
  /Removendo pastas 'forms' e 'uploadfiles'/g,
  "Removendo pasta 'forms'"
);

serverContent = serverContent.replace(
  /Compactando 'forms' e 'uploadfiles'/g,
  "Compactando 'forms'"
);

fs.writeFileSync('server.js', serverContent);


let htmlContent = fs.readFileSync('index.html', 'utf8');

htmlContent = htmlContent.replace(
  /Isso irá transferir as pastas <code>forms<\/code> e <code>uploadfiles<\/code> \(se existir\) da release para a máquina de TST\./g,
  'Isso irá transferir a pasta <code>forms</code> da release para a máquina de TST.'
);

fs.writeFileSync('index.html', htmlContent);

console.log("Done patching uploadfiles removal.");
