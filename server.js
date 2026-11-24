const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT) || 3000;
const pagePath = path.join(__dirname, 'index.html');
const logoPath = path.join(__dirname, 'assets', 'logo-pgri-cikoneng.png');
const offlineFormPath = path.join(__dirname, 'assets', 'spmb-formulir-offline.pdf');
const scholarshipInfoPath = path.join(__dirname, 'assets', 'informasi-beasiswa.pdf');

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const isLogo = pathname === '/assets/logo-pgri-cikoneng.png';
  const isOfflineForm = pathname === '/assets/spmb-formulir-offline.pdf';
  const isScholarshipInfo = pathname === '/assets/informasi-beasiswa.pdf';
  if (request.method !== 'GET' || (!isLogo && !isOfflineForm && !isScholarshipInfo && pathname !== '/' && pathname !== '/index.html')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const filePath = isLogo ? logoPath : isOfflineForm ? offlineFormPath : isScholarshipInfo ? scholarshipInfoPath : pagePath;
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      console.error('Unable to read requested asset:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
      return;
    }

    response.writeHead(200, {
      'Content-Type': isLogo ? 'image/png' : isOfflineForm || isScholarshipInfo ? 'application/pdf' : 'text/html; charset=utf-8',
      'Content-Disposition': isOfflineForm
        ? 'inline; filename="formulir-spmb-offline.pdf"'
        : isScholarshipInfo
          ? 'inline; filename="informasi-beasiswa.pdf"'
          : 'inline',
      'Cache-Control': isLogo || isOfflineForm || isScholarshipInfo ? 'public, max-age=3600' : 'no-cache'
    });
    response.end(contents);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SPMB app listening on port ${port}`);
});
