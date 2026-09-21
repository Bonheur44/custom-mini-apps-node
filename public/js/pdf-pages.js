import { PDFDocument } from '/vendor/pdf-lib/pdf-lib.esm.js';
import { slug } from '/js/slug.js';

// Extracts a page range into a new PDF entirely in the browser: the file never leaves the
// machine, and there is no upload size limit to worry about.

const form = document.getElementById('extract-form');
const fileInput = document.getElementById('file');
const startInput = document.getElementById('start_page');
const endInput = document.getElementById('end_page');
const filenameInput = document.getElementById('filename');
const filenameHint = document.getElementById('filename-hint');
const errorsBox = document.getElementById('errors');
const extractBtn = document.getElementById('extract-btn');
const resultCard = document.getElementById('result-card');
const previewFrame = document.getElementById('preview-frame');
const downloadLink = document.getElementById('download-link');
const closeResultBtn = document.getElementById('close-result');

let currentObjectUrl = null;

function updateFilenameHint() {
    const value = filenameInput.value.trim();
    filenameHint.textContent = value
        ? `Sera enregistré sous : ${slug(value) || 'extrait'}.pdf`
        : "Par défaut : d'après les numéros de page choisis.";
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
    extractBtn.disabled = isLoading;
    extractBtn.classList.toggle('is-loading', isLoading);
}

/** Same rule as the former server route: empty means "not given", otherwise an integer ≥ 1. */
function positiveInt(value) {
    if (value.trim() === '') return null;
    const n = Number(value);

    return Number.isInteger(n) && n >= 1 ? n : NaN;
}

async function loadPdf(file) {
    const bytes = await file.arrayBuffer();
    try {
        return await PDFDocument.load(bytes);
    } catch {
        throw new Error('Ce fichier n’est pas un PDF lisible (ou il est protégé par un mot de passe).');
    }
}

/** @returns {Promise<Blob>} a new PDF holding pages first..last (1-indexed, inclusive) of `source`. */
async function extractPages(source, first, last) {
    const output = await PDFDocument.create();
    const indices = Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i);
    const pages = await output.copyPages(source, indices);
    pages.forEach((page) => output.addPage(page));

    return new Blob([await output.save()], { type: 'application/pdf' });
}

filenameInput.addEventListener('input', updateFilenameHint);
updateFilenameHint();

closeResultBtn.addEventListener('click', () => {
    resultCard.hidden = true;
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();

    const file = fileInput.files[0];
    if (!file) {
        showFormError('Merci de choisir un fichier PDF avant d’extraire.');
        return;
    }
    if (!/\.pdf$/i.test(file.name)) {
        showFormError('Le fichier doit être un PDF.');
        return;
    }

    const first = positiveInt(startInput.value);
    if (first === null) {
        showFormError('Merci d’indiquer une page de départ.');
        startInput.focus();
        return;
    }
    let last = positiveInt(endInput.value) ?? first;
    if (Number.isNaN(first) || Number.isNaN(last)) {
        showFormError('Les pages sont numérotées à partir de 1.');
        return;
    }
    if (last < first) {
        showFormError('La page de fin doit être postérieure ou égale à la page de départ.');
        return;
    }

    setLoading(true);

    try {
        const source = await loadPdf(file);
        const count = source.getPageCount();
        if (first > count) {
            showFormError(`Ce PDF ne comporte que ${count} page(s) — impossible d’extraire à partir de la page ${first}.`);
            return;
        }
        last = Math.min(last, count);

        const blob = await extractPages(source, first, last);
        const requested = slug(filenameInput.value);
        const suggestedName = requested
            ? `${requested}.pdf`
            : (first === last ? `page-${first}.pdf` : `pages-${first}-${last}.pdf`);

        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = URL.createObjectURL(blob);

        previewFrame.src = currentObjectUrl;
        downloadLink.href = currentObjectUrl;
        downloadLink.download = suggestedName;
        resultCard.hidden = false;
        resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        showFormError(error?.message || 'L’extraction a échoué.');
    } finally {
        setLoading(false);
    }
});
