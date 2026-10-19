// Controllo di salute del contenitore (HEALTHCHECK): chiede /health in http o https secondo la configurazione.
import http from 'node:http';
import https from 'node:https';
const tls = !!(process.env.TLS_CERT && process.env.TLS_KEY);
const req = (tls ? https : http).get({ host: '127.0.0.1', port: +process.env.PORT || 8080, path: '/health', rejectUnauthorized: false, timeout: 4000 }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
