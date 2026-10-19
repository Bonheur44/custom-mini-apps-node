import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the browser builds the screens import into `public/vendor/`. Runs on `npm install`
 * (postinstall). Vercel only serves `public/**` as static files and ignores `express.static()`,
 * so serving these straight out of node_modules at request time is not an option there.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const nodeModules = path.join(root, 'node_modules');
const vendor = path.join(root, 'public', 'vendor');

const files = {
    'pdfjs/pdf.mjs': 'pdfjs-dist/build/pdf.mjs',
    'pdfjs/pdf.worker.mjs': 'pdfjs-dist/build/pdf.worker.mjs',
    'pdf-lib/pdf-lib.esm.js': 'pdf-lib/dist/pdf-lib.esm.js',
    'fflate/fflate.esm.js': 'fflate/esm/browser.js',
};

for (const [target, source] of Object.entries(files)) {
    const destination = path.join(vendor, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(nodeModules, source), destination);
}

// pdf.js decodes CCITT/JBIG2/JPX images (common in scanned scores) with WASM modules fetched at
// runtime from `wasmUrl`; without them such images are skipped and the page renders blank.
fs.cpSync(path.join(nodeModules, 'pdfjs-dist', 'wasm'), path.join(vendor, 'pdfjs', 'wasm'), { recursive: true });

console.log(`public/vendor: ${Object.keys(files).length} fichiers + pdfjs/wasm copiés.`);
