const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT) || 3000;
const pagePath = path.join(__dirname, 'index.html');
const logoPath = path.join(__dirname, 'assets', 'logo-pgri-cikoneng.png');

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const isLogo = pathname === '/assets/logo-pgri-cikoneng.png';
  if (request.method !== 'GET' || (!isLogo && pathname !== '/' && pathname !== '/index.html')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  fs.readFile(isLogo ? logoPath : pagePath, (error, contents) => {
    if (error) {
      console.error('Unable to read requested asset:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
      return;
    }

    response.writeHead(200, {
      'Content-Type': isLogo ? 'image/png' : 'text/html; charset=utf-8',
      'Cache-Control': isLogo ? 'public, max-age=3600' : 'no-cache'
    });
    response.end(contents);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SPMB app listening on port ${port}`);
});
