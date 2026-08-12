const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

html = html.replace(
  '<div class="soul-chip-name" title="${m.hostname}">${m.hostname}</div>\r\n          <div class="soul-chip-env ${envLow.startsWith(\'prd\') ? \'prd\' : \'tst\'}">${m.ambiente}</div>',
  '<div class="soul-chip-name" title="${m.hostname}">${m.hostname}</div>\r\n          <div class="soul-chip-env ${envLow.startsWith(\'prd\') ? \'prd\' : \'tst\'}">${m.ambiente}${m.ip ? \' - \' + m.ip : \'\'}</div>'
);

html = html.replace(
  '<span class="soul-bal-info">Jump host: <strong>${balLabel}</strong></span>',
  `<span class="soul-bal-info">Jump host: <strong>\${balLabel}</strong></span>\r\n          <button class="btn-check-versions" style="padding: 2px 6px; font-size: 10px; background: rgba(255,255,255,0.1); margin: 0; margin-left: 10px;" onclick="showBalsModal()">Ver BALs (\${bals.length})</button>`
);

html = html.replace(
  '// ─── Search / filter sidebar',
  `// ─── Search / filter sidebar ──────────────────────────────────────────────────\r\nwindow.showBalsModal = function() {\r\n  if (!soulData || !soulData.bals || !soulData.bals.length) {\r\n    showNotif('Nenhum BAL encontrado para este cliente.', 'warn');\r\n    return;\r\n  }\r\n  const balsHtml = soulData.bals.map(b => \r\n    \`<div style="margin-bottom:8px; padding:8px; background:#1e1e1e; border-radius:4px;">\r\n       <strong>\${b.hostname}</strong><br>\r\n       IP (Private): \${b.ip || 'N/A'}<br>\r\n       IP (Public): \${b.public_ip || '---'}<br>\r\n       Tenancy: \${b.tenancy || 'N/A'}\r\n     </div>\`\r\n  ).join('');\r\n  showConfirmModal('BALs Configurados', \`<div style="max-height:300px; overflow-y:auto; text-align:left;">\${balsHtml}</div>\`);\r\n};\r\n\r\n// ─── Search / filter sidebar`
);

fs.writeFileSync('index.html', html);
console.log('index.html patched');
