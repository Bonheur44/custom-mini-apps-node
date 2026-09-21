import { fileURLToPath } from 'node:url';
import express from 'express';
import { ToolError, ValidationError } from './lib/errors.js';
import { api } from './routes/api.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export const app = express();

// Vercel picks this file as the function entrypoint (it is the one that imports `express`) and
// needs the app as the default export; `server.js` only runs on a real server.
export default app;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

// Screens: self-contained HTML files, one per tool, same URLs as the Laravel app. Each path is a
// `new URL(literal, import.meta.url)` so Vercel's file tracer (nft) sees them and ships them
// with the function bundle; a `path.join(dir, variable)` would be pruned as "unused".
const pages = {
    '/': new URL('../views/portal.html', import.meta.url),
    '/convert': new URL('../views/convert.html', import.meta.url),
    '/pdf-editor': new URL('../views/pdf-editor.html', import.meta.url),
    '/lyrics-extractor': new URL('../views/ocr.html', import.meta.url),
    '/video-downloader': new URL('../views/downloader.html', import.meta.url),
    '/pdf-pages': new URL('../views/pdf-pages.html', import.meta.url),
    '/pdf-split': new URL('../views/pdf-split.html', import.meta.url),
};

for (const [route, file] of Object.entries(pages)) {
    app.get(route, (req, res) => res.sendFile(fileURLToPath(file)));
}

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Browser-side code and the vendor builds `scripts/copy-vendor.js` puts in `public/vendor/`.
// On Vercel this middleware is ignored and `public/**` is served by its CDN at the same paths.
app.use(express.static(`${root}public`));

app.use('/api', api);

app.use((req, res) => {
    res.status(404).json({ message: 'Ressource introuvable.' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
    if (error instanceof ValidationError) {
        return res.status(error.status).json({ message: error.message, errors: error.errors });
    }
    if (error instanceof ToolError) {
        return res.status(error.status).json({ message: error.message });
    }
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
        return res.status(400).json({ message: 'Requête invalide.' });
    }

    console.error(error);
    res.status(500).json({ message: 'Une erreur inattendue est survenue.' });
});
