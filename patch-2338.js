const fs = require('fs');

const path = './inventario_geral_maquinas.json';
let data = JSON.parse(fs.readFileSync(path, 'utf8'));

const entriesToAdd = [
  {
    hostname: '2338PRD-APOIO-WIN01',
    ip: '10.99.0.5, 164.152.59.65',
    codigo: '2338',
    tenancy: 'MVCLIENTESAAS',
    senha: 'MvMv@@2019-9102',
    dns: '2338PRD-APOIO-WIN01.cloudmv.com.br',
    ambiente: 'PRD',
    source: 'manual_update'
  },
  {
    hostname: '2338TST1-BAL-LNX01',
    ip: '10.99.0.6, 144.22.165.115',
    codigo: '2338',
    tenancy: 'MVCLIENTESAAS',
    senha: 'MvMv@@2019-9102',
    dns: '2338TST1-BAL-LNX01.cloudmv.com.br',
    ambiente: 'TST',
    source: 'manual_update'
  }
];

let updatedCount = 0;
let addedCount = 0;

entriesToAdd.forEach(newEntry => {
  const existingIndex = data.findIndex(e => e.hostname === newEntry.hostname);
  if (existingIndex !== -1) {
    data[existingIndex] = { ...data[existingIndex], ...newEntry };
    updatedCount++;
  } else {
    data.push(newEntry);
    addedCount++;
  }
});

fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
console.log(`Atualizados: ${updatedCount}, Adicionados: ${addedCount}`);
