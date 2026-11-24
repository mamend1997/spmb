const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT) || 3000;
const pagePath = path.join(__dirname, 'index.html');

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  fs.readFile(pagePath, (error, contents) => {
    if (error) {
      console.error('Unable to read index.html:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    response.end(contents);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SPMB app listening on port ${port}`);
});
