import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (process.env.PROVIDER_LOG) require('node:fs').appendFileSync(process.env.PROVIDER_LOG, JSON.stringify({ url: req.url, method: req.method, body: body.slice(0, 400) }) + '\n');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'soak' + n } }] }) + '\n\n');
      if (n >= 200) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); }
    }, 40);
    req.on('close', () => clearInterval(timer));
  });
}).listen(port, '127.0.0.1', () => console.log('provider on ' + port));