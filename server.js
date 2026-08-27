'use strict';

// Minimal zero-dependency static server.
//   node server.js            -> http://localhost:3500
//   node server.js --port 8080
//   PORT=8080 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;

const argIndex = process.argv.indexOf('--port');
const PORT = Number(
  (argIndex !== -1 && process.argv[argIndex + 1]) || process.env.PORT || 3500
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (pathname === '/') pathname = '/index.html';

  // Block path traversal: the resolved file must stay inside ROOT
  const filePath = path.join(ROOT, pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  fs.stat(filePath, (err, stat) => {
    console.log(`${req.method} ${pathname} -> ${err || !stat.isFile() ? 404 : 200}`);
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try: node server.js --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log(`\n  Chord Detector is running:`);
  console.log(`    http://localhost:${PORT}      <-- use this one, the mic works here`);
  lan.forEach((ip) => console.log(`    http://${ip}:${PORT}`));
  if (lan.length) {
    console.log(`\n  Note: the LAN addresses above are NOT a secure context, so the browser`);
    console.log(`  will block microphone access. To test on a phone, use HTTPS or an SSH tunnel.`);
  }
  console.log(`\n  Ctrl+C to stop.\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
