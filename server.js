import 'dotenv/config';
import http from 'node:http';
import { app } from './src/app.js';
import { closeBrowser } from './src/services/htmlToPdf.js';

const port = Number(process.env.PORT) || 3000;

// On Vercel, `listen` is intercepted and the app runs as one function; this file is still the
// detected entrypoint, so nothing below may assume a real server exists.
const server = app.listen(port, () => {
    console.log(`Portail disponible sur http://localhost:${port}`);
});

if (server instanceof http.Server) {
    // Long downloads (yt-dlp) can legitimately run for minutes; Node's default is 5 min.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
}

async function shutdown() {
    await closeBrowser();
    server?.close?.(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
