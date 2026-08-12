const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
  conn.exec('ping -c 3 10.32.1.4', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Ping check finished with code ' + code);
      conn.end();
    }).on('data', (data) => {
      console.log('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
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
