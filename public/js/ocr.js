import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs';
import Tesseract from 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.esm.min.js';
import { normalizeLyrics } from '/js/lyrics-normalizer.js';

// OCR entirely in the browser: pdf.js renders each page to a canvas, tesseract.js (Tesseract
// compiled to WebAssembly) reads it. The engine and the French model are fetched from
// tesseract.js's default CDNs on first use, then cached by the browser.

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

// ~300 dpi for a Letter/A4 page: below that, small score text under the notes gets hard to
// recognize; the cap keeps the canvas within what mobile browsers allocate.
const TARGET_DPI = 300;
const MAX_SIDE_PX = 4000;
const LANGUAGE = 'fra';

const fichierInput = document.getElementById('fichier');
const extraireBtn = document.getElementById('extraire-btn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const texteArea = document.getElementById('texte');
const copierBtn = document.getElementById('copier-btn');
const telechargerBtn = document.getElementById('telecharger-btn');

function setStatus(message, type = 'info') {
    statusEl.innerHTML = '';
    if (!message) return;
    const div = document.createElement('div');
    div.className = `status status-${type}`;
    div.textContent = message;
    statusEl.appendChild(div);
}

/** Renders page `number` (1-indexed) of `pdf` to a canvas at roughly TARGET_DPI. */
async function renderPage(pdf, number) {
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(TARGET_DPI / 72, MAX_SIDE_PX / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext('2d');
    // Scans are usually transparent-free, but a page with no background must not be read as black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    page.cleanup();

    return canvas;
}

/** @returns {Promise<{ text: string, pageCount: number }>} */
async function extractText(file) {
    const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
    let pdf;
    try {
        pdf = await loadingTask.promise;
    } catch {
        throw new Error('Ce fichier n’est pas un PDF lisible (ou il est protégé par un mot de passe).');
    }

    setStatus('Chargement du moteur de reconnaissance (une dizaine de Mo au premier lancement)…');
    const worker = await Tesseract.createWorker(LANGUAGE);

    try {
        const textByPage = [];

        for (let number = 1; number <= pdf.numPages; number++) {
            setStatus(`Lecture de la page ${number} sur ${pdf.numPages}…`);
            const canvas = await renderPage(pdf, number);
            const { data } = await worker.recognize(canvas);
            const text = data.text.trim();
            if (text !== '') textByPage.push(text);
        }

        return { text: normalizeLyrics(textByPage.join('\n\n')), pageCount: pdf.numPages };
    } finally {
        await worker.terminate();
        await loadingTask.destroy();
    }
}

extraireBtn.addEventListener('click', async () => {
    const fichier = fichierInput.files[0];
    if (!fichier) {
        setStatus('Choisissez un fichier PDF avant d’extraire.', 'error');
        return;
    }
    if (!/\.pdf$/i.test(fichier.name)) {
        setStatus('Le fichier doit être un PDF.', 'error');
        return;
    }

    setStatus(null);
    extraireBtn.disabled = true;
    extraireBtn.classList.add('is-loading');

    try {
        const { text, pageCount } = await extractText(fichier);

        texteArea.value = text;
        resultEl.hidden = false;
        setStatus(`${pageCount} page(s) lue(s). Relisez le texte ci-dessous avant de l'utiliser.`, 'info');
        resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        setStatus(error?.message || "L'extraction a échoué.", 'error');
    } finally {
        extraireBtn.disabled = false;
        extraireBtn.classList.remove('is-loading');
    }
});

copierBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(texteArea.value);
        setStatus('Texte copié dans le presse-papiers.', 'info');
    } catch {
        setStatus('La copie a échoué — sélectionnez et copiez manuellement.', 'error');
    }
});

telechargerBtn.addEventListener('click', () => {
    const blob = new Blob([texteArea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paroles-extraites.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
});
