const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

html = html.replace(
  /<div class="logo-wrapper" style="position: relative; display: inline-block; padding: 4px; border-radius: 8px;">\s*<div class="orbital-glow"><\/div>\s*<img src="assets\/img\/logo_flowti_branca\.png" alt="Flowti Logo" style="height: 24px; position: relative; z-index: 2; display: block;">\s*<\/div>/g,
  '<img src="assets/img/logo_flowti_branca.png" alt="Flowti Logo" class="logo-flowti">'
);

fs.writeFileSync('index.html', html, 'utf8');
