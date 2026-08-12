const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
  conn.exec('timeout 5 bash -c "</dev/tcp/10.32.1.2/22"', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('tcp check finished with code ' + code);
      conn.end();
    });
  });
}).on('error', (err) => {
  console.error('BAL Connection Error:', err);
}).connect({
  host: '152.67.37.133',
  port: 22,
  username: 'mv-portal',
  password: 'MvMv@@20192019',
  readyTimeout: 10000
});
