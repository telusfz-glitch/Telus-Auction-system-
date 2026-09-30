// Demo only. Inside a container, forwards 127.0.0.1:<port> to <host>:<port> so the web app and the API reach
// Keycloak at the same address the browser uses (http://localhost:8080). The OIDC issuer then matches everywhere.
const net = require('net');
const [port, target] = [Number(process.argv[2]), process.argv[3]];
const [host, tport] = target.split(':');
net.createServer((c) => {
  const u = net.connect(Number(tport), host);
  c.pipe(u).pipe(c);
  const close = () => { c.destroy(); u.destroy(); };
  c.on('error', close); u.on('error', close);
}).listen(port, '127.0.0.1');
