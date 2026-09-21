import { PDFDocument } from '/vendor/pdf-lib/pdf-lib.esm.js';
import { zipSync } from '/vendor/fflate/fflate.esm.js';
import { slug } from '/js/slug.js';

// Splits a PDF into one file per page and zips them, entirely in the browser.

const form = document.getElementById('split-form');
const fileInput = document.getElementById('file');
const filenameInput = document.getElementById('filename');
const filenameHint = document.getElementById('filename-hint');
const errorsBox = document.getElementById('errors');
const splitBtn = document.getElementById('split-btn');
const resultCard = document.getElementById('result-card');
const resultCount = document.getElementById('result-count');
const resultLabel = document.getElementById('result-label');
const resultDetail = document.getElementById('result-detail');
const downloadLink = document.getElementById('download-link');
const closeResultBtn = document.getElementById('close-result');

let currentObjectUrl = null;

function baseName() {
    const typed = slug(filenameInput.value);
    if (typed) return typed;

    const file = fileInput.files[0];

    return (file && slug(file.name.replace(/\.pdf$/i, ''))) || 'document';
}

function updateFilenameHint() {
    const base = baseName();
    filenameHint.textContent = `Archive : ${base}-pages.zip — fichiers : ${base}-page-01.pdf, ${base}-page-02.pdf…`;
}

function clearErrors() {
    errorsBox.innerHTML = '';
}

function showFormError(message) {
    const el = document.createElement('div');
    el.className = 'error';
    el.textContent = message;
    errorsBox.appendChild(el);
}

function setLoading(isLoading) {
    splitBtn.disabled = isLoading;
    splitBtn.classList.toggle('is-loading', isLoading);
}

async function loadPdf(file) {
    const bytes = await file.arrayBuffer();
    try {
        return await PDFDocument.load(bytes);
    } catch {
        throw new Error('Ce fichier n’est pas un PDF lisible (ou il est protégé par un mot de passe).');
    }
}

/**
 * Writes `<prefix>-page-NN.pdf` (zero-padded so files sort in page order, at least two digits)
 * for every page of `source` into a ZIP and returns it with the page count.
 */
async function splitToZip(source, prefix) {
    const count = source.getPageCount();
    const width = Math.max(2, String(count).length);
    const entries = {};

    for (let index = 0; index < count; index++) {
        const single = await PDFDocument.create();
        const [page] = await single.copyPages(source, [index]);
        single.addPage(page);
        entries[`${prefix}-page-${String(index + 1).padStart(width, '0')}.pdf`] = await single.save();
    }

    const zipped = zipSync(entries, { level: 6 });

    return { blob: new Blob([zipped], { type: 'application/zip' }), pageCount: count };
}

filenameInput.addEventListener('input', updateFilenameHint);
fileInput.addEventListener('change', updateFilenameHint);
updateFilenameHint();

closeResultBtn.addEventListener('click', () => {
    resultCard.hidden = true;
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();

    const file = fileInput.files[0];
    if (!file) {
        showFormError('Merci de choisir un fichier PDF avant de découper.');
        return;
    }
    if (!/\.pdf$/i.test(file.name)) {
        showFormError('Le fichier doit être un PDF.');
        return;
    }

    setLoading(true);

    try {
        const source = await loadPdf(file);
        const base = baseName();
        const { blob, pageCount } = await splitToZip(source, base);
        const suggestedName = `${base}-pages.zip`;

        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = URL.createObjectURL(blob);

        resultCount.textContent = pageCount || '—';
        resultLabel.textContent = pageCount === 1 ? 'fichier PDF dans l’archive' : 'fichiers PDF dans l’archive';
        resultDetail.textContent = `${suggestedName} · ${Math.round(blob.size / 1024)} Ko`;
        downloadLink.href = currentObjectUrl;
        downloadLink.download = suggestedName;
        resultCard.hidden = false;
        resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        showFormError(error?.message || 'Le découpage a échoué.');
    } finally {
        setLoading(false);
    }
});
