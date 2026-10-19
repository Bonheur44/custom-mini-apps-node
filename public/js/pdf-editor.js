import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs';
import { PDFDocument, degrees } from '/vendor/pdf-lib/pdf-lib.esm.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

const PDFJS_WASM_URL = `${window.location.origin}/vendor/pdfjs/wasm/`;

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_TOTAL_PAGES = 500;
const THUMB_WIDTH = 180;
const PREVIEW_MAX_CSS_WIDTH = 1000;
const PREVIEW_MAX_ZOOM = 3; // relative to the page's natural size (avoids needless oversampling on small formats)
const TOAST_DURATION = 4000;

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const toastStack = document.getElementById('toast-stack');
const filesList = document.getElementById('files-list');
const toolbar = document.getElementById('toolbar');
const counter = document.getElementById('counter');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const resetBtn = document.getElementById('reset-btn');
const bulkBar = document.getElementById('bulk-bar');
const bulkCount = document.getElementById('bulk-count');
const bulkRotateBtn = document.getElementById('bulk-rotate');
const bulkDeleteBtn = document.getElementById('bulk-delete');
const bulkClearBtn = document.getElementById('bulk-clear');
const grid = document.getElementById('grid');
const exportBar = document.getElementById('export-bar');
const filenameInput = document.getElementById('filename-input');
const exportBtn = document.getElementById('export-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const previewModal = document.getElementById('preview-modal');
const previewBackdrop = document.getElementById('preview-backdrop');
const previewCloseBtn = document.getElementById('preview-close');
const previewPrevBtn = document.getElementById('preview-prev');
const previewNextBtn = document.getElementById('preview-next');
const previewPageLabel = document.getElementById('preview-page-label');
const previewZoomInBtn = document.getElementById('preview-zoom-in');
const previewZoomOutBtn = document.getElementById('preview-zoom-out');
const previewScroll = document.getElementById('preview-scroll');
const previewCanvas = document.getElementById('preview-canvas');

/**
 * @typedef {{ name: string, bytes: Uint8Array, pdfjsDoc: import('pdfjs-dist').PDFDocumentProxy, loadingTask: import('pdfjs-dist').PDFDocumentLoadingTask, numPages: number, pdfLibDocPromise: Promise<PDFDocument> | null }} Source
 * @typedef {{ id: string, sourceId: string, pageIndexInSource: number, rotation: number }} Page
 */

const state = {
    /** @type {Map<string, Source>} */
    sources: new Map(),
    /** @type {Page[]} */
    pages: [],
    /** @type {Page[][]} */
    history: [],
    /** @type {Page[][]} */
    future: [],
    /** @type {Set<string>} */
    selectedIds: new Set(),
};

/** @type {Map<string, HTMLCanvasElement>} */
const canvasCache = new Map();

let gridObserver = null;
let selectionAnchorIndex = null;
let pointerDrag = null;
let previewIndex = -1;
let previewZoom = 1;
let previewLastFocused = null;

function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`;
}

function isAlreadyImported(file) {
    for (const source of state.sources.values()) {
        if (source.name === file.name && source.bytes.length === file.size) return true;
    }
    return false;
}

function showToast(message, type = 'error', persist = type === 'error') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Fermer la notification');
    closeBtn.addEventListener('click', () => el.remove());

    el.append(text, closeBtn);
    toastStack.appendChild(el);

    if (!persist) setTimeout(() => el.remove(), TOAST_DURATION);
}

function setLoading(visible, text = '') {
    loadingOverlay.hidden = !visible;
    loadingText.textContent = text;
}

function clonePages(pages) {
    return pages.map((p) => ({ ...p }));
}

function snapshot() {
    state.history.push(clonePages(state.pages));
    state.future = [];
}

function undo() {
    if (state.history.length === 0) return;
    state.future.push(clonePages(state.pages));
    state.pages = state.history.pop();
    render();
}

function redo() {
    if (state.future.length === 0) return;
    state.history.push(clonePages(state.pages));
    state.pages = state.future.pop();
    render();
}

function resetAll() {
    state.pages = [];
    state.history = [];
    state.future = [];
    state.selectedIds.clear();
    state.sources.forEach((source) => source.loadingTask.destroy());
    state.sources.clear();
    canvasCache.clear();
    fileInput.value = '';
    render();
}

function totalPages() {
    return state.pages.length;
}

function totalOriginalPages() {
    let total = 0;
    state.sources.forEach((source) => { total += source.numPages; });
    return total;
}

async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((file) => {
        if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
            showToast(`« ${file.name} » n'est pas un fichier PDF.`);
            return false;
        }
        if (file.size > MAX_FILE_SIZE) {
            showToast(`« ${file.name} » dépasse la taille maximale autorisée (${MAX_FILE_SIZE / 1024 / 1024} Mo).`);
            return false;
        }
        return true;
    });

    if (files.length === 0) return;

    setLoading(true, 'Import des fichiers…');

    for (const file of files) {
        if (isAlreadyImported(file)) {
            showToast(`« ${file.name} » est déjà importé — il est ajouté une nouvelle fois avec ses propres pages.`, 'info', true);
        }

        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            // pdf.js may consume this buffer, so pass a copy and keep `bytes` for pdf-lib later.
            const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), wasmUrl: PDFJS_WASM_URL });
            const pdfjsDoc = await loadingTask.promise;

            if (totalPages() + pdfjsDoc.numPages > MAX_TOTAL_PAGES) {
                showToast(`Import de « ${file.name} » refusé : la limite de ${MAX_TOTAL_PAGES} pages au total serait dépassée.`);
                loadingTask.destroy();
                continue;
            }

            const sourceId = uid();
            state.sources.set(sourceId, {
                name: file.name,
                bytes,
                pdfjsDoc,
                loadingTask,
                numPages: pdfjsDoc.numPages,
                pdfLibDocPromise: null,
            });

            snapshot();
            for (let i = 0; i < pdfjsDoc.numPages; i++) {
                state.pages.push({ id: uid(), sourceId, pageIndexInSource: i, rotation: 0 });
            }
        } catch (e) {
            const reason = e && e.name === 'PasswordException'
                ? 'protégé par mot de passe'
                : 'fichier corrompu ou illisible';
            showToast(`Impossible d'ouvrir « ${file.name} » (${reason}).`);
        }
    }

    setLoading(false);
    render();
}

function removeSource(sourceId) {
    const source = state.sources.get(sourceId);
    if (!source) return;

    snapshot();
    state.pages = state.pages.filter((p) => {
        if (p.sourceId !== sourceId) return true;
        canvasCache.delete(p.id);
        state.selectedIds.delete(p.id);
        return false;
    });
    source.loadingTask.destroy();
    state.sources.delete(sourceId);
    render();
}

function findPageIndex(id) {
    return state.pages.findIndex((p) => p.id === id);
}

function deletePage(id) {
    const index = findPageIndex(id);
    if (index === -1) return;
    snapshot();
    state.pages.splice(index, 1);
    canvasCache.delete(id);
    state.selectedIds.delete(id);
    render();
}

function movePage(id, direction) {
    const index = findPageIndex(id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= state.pages.length) return;
    snapshot();
    const [page] = state.pages.splice(index, 1);
    state.pages.splice(target, 0, page);
    render();
}

function rotatePage(id) {
    const index = findPageIndex(id);
    if (index === -1) return;
    snapshot();
    const page = state.pages[index];
    state.pages[index] = { ...page, rotation: (page.rotation + 90) % 360 };
    canvasCache.delete(id);
    render();
}

function reorderWithPosition(draggedId, targetId, insertBefore) {
    if (draggedId === targetId) return;
    const fromIndex = findPageIndex(draggedId);
    if (fromIndex === -1) return;

    snapshot();
    const [page] = state.pages.splice(fromIndex, 1);
    const targetIndex = state.pages.findIndex((p) => p.id === targetId);
    if (targetIndex === -1) {
        // the target has disappeared in the meantime (edge case): put it back where it was
        state.pages.splice(fromIndex, 0, page);
        state.history.pop();
        return;
    }
    const insertAt = insertBefore ? targetIndex : targetIndex + 1;
    state.pages.splice(insertAt, 0, page);
    render();
}

function deleteSelected() {
    if (state.selectedIds.size === 0) return;
    snapshot();
    state.pages = state.pages.filter((p) => {
        if (!state.selectedIds.has(p.id)) return true;
        canvasCache.delete(p.id);
        return false;
    });
    state.selectedIds.clear();
    render();
}

function rotateSelected() {
    if (state.selectedIds.size === 0) return;
    snapshot();
    state.pages = state.pages.map((p) => {
        if (!state.selectedIds.has(p.id)) return p;
        canvasCache.delete(p.id);
        return { ...p, rotation: (p.rotation + 90) % 360 };
    });
    render();
}

function updateBulkBar() {
    const count = state.selectedIds.size;
    bulkBar.hidden = count === 0;
    bulkCount.textContent = `${count} page${count > 1 ? 's' : ''} sélectionnée${count > 1 ? 's' : ''}`;
}

function updateSelectionUI() {
    grid.querySelectorAll('.page-card').forEach((card) => {
        const selected = state.selectedIds.has(card.dataset.id);
        card.classList.toggle('is-selected', selected);
        const checkbox = card.querySelector('input[data-select]');
        if (checkbox) checkbox.checked = selected;
    });
    updateBulkBar();
}

function handleSelectClick(checkbox, shiftKey) {
    const card = checkbox.closest('.page-card');
    const id = card.dataset.id;
    const index = findPageIndex(id);

    if (shiftKey && selectionAnchorIndex !== null) {
        const [start, end] = [selectionAnchorIndex, index].sort((a, b) => a - b);
        for (let i = start; i <= end; i++) state.selectedIds.add(state.pages[i].id);
    } else {
        if (checkbox.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
        selectionAnchorIndex = index;
    }
    updateSelectionUI();
}

// `render()` rebuilds the grid and loses focus each time — capture/restore it around that.
function captureFocus() {
    const active = document.activeElement;
    if (!active || !grid.contains(active)) return null;
    const card = active.closest('.page-card');
    if (!card) return null;
    const cards = Array.from(grid.querySelectorAll('.page-card'));
    return {
        pageId: card.dataset.id,
        action: active.dataset.action || null,
        index: cards.indexOf(card),
    };
}

function restoreFocus(info) {
    if (!info) return;
    const cards = grid.querySelectorAll('.page-card');
    if (cards.length === 0) {
        (undoBtn.disabled ? dropZone.querySelector('label') : undoBtn)?.focus();
        return;
    }

    const card = grid.querySelector(`.page-card[data-id="${info.pageId}"]`) || cards[Math.min(info.index, cards.length - 1)];
    const target = (info.action && card.querySelector(`button[data-action="${info.action}"]`))
        || card.querySelector('button[data-action="delete"]');
    target?.focus();
}

async function renderThumbnail(page, canvas) {
    const source = state.sources.get(page.sourceId);
    if (!source) return;

    const pdfPage = await source.pdfjsDoc.getPage(page.pageIndexInSource + 1);
    // `rotation` replaces the page's intrinsic /Rotate rather than adding to it — combine manually.
    const effectiveRotation = (pdfPage.rotate + page.rotation) % 360;
    const baseViewport = pdfPage.getViewport({ scale: 1, rotation: effectiveRotation });
    const scale = THUMB_WIDTH / baseViewport.width;
    const viewport = pdfPage.getViewport({ scale, rotation: effectiveRotation });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const context = canvas.getContext('2d');
    await pdfPage.render({ canvasContext: context, viewport }).promise;
    canvas.closest('.page-card-canvas')?.classList.remove('is-loading');
}

function closePreview() {
    previewModal.hidden = true;
    previewLastFocused?.focus();
}

async function renderPreviewPage() {
    const page = state.pages[previewIndex];
    if (!page) { closePreview(); return; }
    const source = state.sources.get(page.sourceId);
    if (!source) { closePreview(); return; }

    previewPageLabel.textContent = `Page ${previewIndex + 1} sur ${state.pages.length}`;
    previewPrevBtn.disabled = previewIndex === 0;
    previewNextBtn.disabled = previewIndex === state.pages.length - 1;
    previewScroll.scrollTop = 0;
    previewScroll.scrollLeft = 0;

    try {
        const pdfPage = await source.pdfjsDoc.getPage(page.pageIndexInSource + 1);
        const effectiveRotation = (pdfPage.rotate + page.rotation) % 360;
        const baseViewport = pdfPage.getViewport({ scale: 1, rotation: effectiveRotation });

        const dpr = window.devicePixelRatio || 1;
        // Rendered at natural size (scaled by zoom), not forced to fit — hence the scrolling.
        const fitWidth = Math.min(
            PREVIEW_MAX_CSS_WIDTH,
            window.innerWidth - 96,
            baseViewport.width * PREVIEW_MAX_ZOOM
        );
        const cssWidth = fitWidth * previewZoom;
        const scale = (cssWidth / baseViewport.width) * dpr;
        const viewport = pdfPage.getViewport({ scale, rotation: effectiveRotation });

        previewCanvas.width = viewport.width;
        previewCanvas.height = viewport.height;
        previewCanvas.style.width = `${viewport.width / dpr}px`;
        previewCanvas.style.height = `${viewport.height / dpr}px`;

        await pdfPage.render({ canvasContext: previewCanvas.getContext('2d'), viewport }).promise;
    } catch {
        showToast("Impossible d'afficher l'aperçu agrandi de cette page.");
        closePreview();
    }
}

function openPreview(page) {
    previewIndex = findPageIndex(page.id);
    if (previewIndex === -1) return;
    previewZoom = 1;
    previewLastFocused = document.activeElement;
    previewModal.hidden = false;
    previewCloseBtn.focus();
    renderPreviewPage();
}

function navigatePreview(delta) {
    const newIndex = previewIndex + delta;
    if (newIndex < 0 || newIndex >= state.pages.length) return;
    previewIndex = newIndex;
    previewZoom = 1;
    renderPreviewPage();
}

function zoomPreview(factor) {
    previewZoom = Math.min(3, Math.max(0.4, previewZoom * factor));
    renderPreviewPage();
}

function trapPreviewFocus(event) {
    if (event.key !== 'Tab') return;
    const focusables = Array.from(previewModal.querySelectorAll('button:not(:disabled)'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function buildCard(page, index) {
    const source = state.sources.get(page.sourceId);

    const card = document.createElement('div');
    card.className = 'page-card';
    if (state.selectedIds.has(page.id)) card.classList.add('is-selected');
    card.dataset.id = page.id;

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'page-card-canvas';
    canvasWrap.setAttribute('role', 'img');
    canvasWrap.setAttribute(
        'aria-label',
        `Page ${page.pageIndexInSource + 1}${source ? ` de ${source.name}` : ''}, aperçu agrandissable`
    );

    let canvas = canvasCache.get(page.id);
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvasCache.set(page.id, canvas);
        canvas.dataset.pending = 'true';
        canvasWrap.classList.add('is-loading');
    }
    canvasWrap.appendChild(canvas);

    const info = document.createElement('div');
    info.className = 'page-card-info';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'page-checkbox';
    checkbox.dataset.select = 'true';
    checkbox.checked = state.selectedIds.has(page.id);
    checkbox.setAttribute('aria-label', `Sélectionner la page ${index + 1}`);

    const numEl = document.createElement('span');
    numEl.className = 'page-num';
    numEl.textContent = String(index + 1);

    const badge = document.createElement('span');
    badge.className = 'page-badge';
    badge.title = source ? source.name : '';
    badge.textContent = source ? `${source.name} · p. ${page.pageIndexInSource + 1}` : '';

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.dataset.dragHandle = 'true';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Glisser pour réordonner';
    handle.textContent = '⠿';

    info.append(checkbox, numEl, badge, handle);

    const actions = document.createElement('div');
    actions.className = 'page-card-actions';
    actions.innerHTML = `
        <div class="action-group">
            <button type="button" data-action="left" title="Déplacer à gauche" aria-label="Déplacer la page vers la gauche" ${index === 0 ? 'disabled' : ''}>&lsaquo;</button>
            <button type="button" data-action="right" title="Déplacer à droite" aria-label="Déplacer la page vers la droite" ${index === state.pages.length - 1 ? 'disabled' : ''}>&rsaquo;</button>
        </div>
        <button type="button" data-action="rotate" title="Pivoter de 90°" aria-label="Pivoter la page de 90 degrés">&#8635;</button>
        <button type="button" data-action="delete" class="danger" title="Supprimer" aria-label="Supprimer la page">&times;</button>
    `;

    card.append(canvasWrap, info, actions);
    return card;
}

function renderFilesList() {
    filesList.innerHTML = '';
    filesList.hidden = state.sources.size === 0;

    state.sources.forEach((source, sourceId) => {
        const remainingPages = state.pages.filter((p) => p.sourceId === sourceId).length;

        const row = document.createElement('div');
        row.className = 'file-row';

        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = source.name;
        name.title = source.name;

        const pagesInfo = document.createElement('span');
        pagesInfo.className = 'file-pages';
        pagesInfo.textContent = `${remainingPages}/${source.numPages} page${source.numPages > 1 ? 's' : ''}`;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'Retirer';
        removeBtn.setAttribute('aria-label', `Retirer le fichier ${source.name}`);
        removeBtn.addEventListener('click', () => removeSource(sourceId));

        row.append(name, pagesInfo, removeBtn);
        filesList.appendChild(row);
    });
}

function render() {
    const focusInfo = captureFocus();

    const hasFiles = state.sources.size > 0;
    toolbar.hidden = !hasFiles;
    exportBar.hidden = !hasFiles;
    dropZone.classList.toggle('is-compact', hasFiles);
    undoBtn.disabled = state.history.length === 0;
    redoBtn.disabled = state.future.length === 0;
    exportBtn.disabled = totalPages() === 0;
    counter.textContent = `${totalPages()} page${totalPages() > 1 ? 's' : ''} conservée${totalPages() > 1 ? 's' : ''} sur ${totalOriginalPages()}`;

    grid.innerHTML = '';
    const fragment = document.createDocumentFragment();
    state.pages.forEach((page, index) => fragment.appendChild(buildCard(page, index)));
    grid.appendChild(fragment);

    if (gridObserver) gridObserver.disconnect();
    gridObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const canvas = entry.target;
            gridObserver.unobserve(canvas);
            if (canvas.dataset.pending !== 'true') return;
            delete canvas.dataset.pending;
            const id = canvas.closest('.page-card').dataset.id;
            const page = state.pages.find((p) => p.id === id);
            if (page) renderThumbnail(page, canvas).catch(() => showToast('Erreur lors du rendu d\'une vignette.'));
        });
    }, { root: null, rootMargin: '200px' });

    grid.querySelectorAll('canvas').forEach((canvas) => gridObserver.observe(canvas));

    updateBulkBar();
    renderFilesList();
    restoreFocus(focusInfo);
}

function clearDropIndicators() {
    grid.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
        el.classList.remove('drop-before', 'drop-after');
    });
}

grid.addEventListener('click', (event) => {
    const checkbox = event.target.closest('input[data-select]');
    if (checkbox) {
        handleSelectClick(checkbox, event.shiftKey);
        return;
    }

    const button = event.target.closest('button[data-action]');
    if (button) {
        const id = button.closest('.page-card').dataset.id;

        switch (button.dataset.action) {
            case 'left': movePage(id, -1); break;
            case 'right': movePage(id, 1); break;
            case 'rotate': rotatePage(id); break;
            case 'delete': deletePage(id); break;
        }
        return;
    }

    const canvasWrap = event.target.closest('.page-card-canvas');
    if (canvasWrap) {
        const id = canvasWrap.closest('.page-card').dataset.id;
        const page = state.pages.find((p) => p.id === id);
        if (page) openPreview(page);
    }
});

// Pointer Events instead of the HTML5 Drag API, which doesn't work on touch screens.
grid.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-drag-handle]');
    if (!handle) return;
    const card = handle.closest('.page-card');
    if (!card) return;

    event.preventDefault();
    const rect = card.getBoundingClientRect();

    const ghost = card.cloneNode(true);
    // cloneNode() doesn't copy a <canvas>'s drawn content — redraw it on the ghost manually.
    const originalCanvas = card.querySelector('canvas');
    const ghostCanvas = ghost.querySelector('canvas');
    if (originalCanvas && ghostCanvas) {
        ghostCanvas.width = originalCanvas.width;
        ghostCanvas.height = originalCanvas.height;
        ghostCanvas.getContext('2d').drawImage(originalCanvas, 0, 0);
    }
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);

    pointerDrag = {
        id: card.dataset.id,
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        ghost,
        dropTarget: null,
    };
    card.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);
});

document.addEventListener('pointermove', (event) => {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;

    pointerDrag.ghost.style.left = `${event.clientX - pointerDrag.offsetX}px`;
    pointerDrag.ghost.style.top = `${event.clientY - pointerDrag.offsetY}px`;

    clearDropIndicators();
    pointerDrag.ghost.hidden = true;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.page-card');
    pointerDrag.ghost.hidden = false;

    if (!target || target.dataset.id === pointerDrag.id) {
        pointerDrag.dropTarget = null;
        return;
    }

    const rect = target.getBoundingClientRect();
    const insertBefore = event.clientX < rect.left + rect.width / 2;
    target.classList.add(insertBefore ? 'drop-before' : 'drop-after');
    pointerDrag.dropTarget = { id: target.dataset.id, insertBefore };
});

function endPointerDrag(event) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const { id, dropTarget, ghost } = pointerDrag;

    ghost.remove();
    clearDropIndicators();
    grid.querySelector(`.page-card[data-id="${id}"]`)?.classList.remove('dragging');
    pointerDrag = null;

    if (dropTarget) reorderWithPosition(id, dropTarget.id, dropTarget.insertBefore);
}

document.addEventListener('pointerup', endPointerDrag);
document.addEventListener('pointercancel', endPointerDrag);

previewCloseBtn.addEventListener('click', closePreview);
previewBackdrop.addEventListener('click', closePreview);
previewPrevBtn.addEventListener('click', () => navigatePreview(-1));
previewNextBtn.addEventListener('click', () => navigatePreview(1));
previewZoomInBtn.addEventListener('click', () => zoomPreview(1.25));
previewZoomOutBtn.addEventListener('click', () => zoomPreview(0.8));

document.addEventListener('keydown', (event) => {
    if (!previewModal.hidden) {
        if (event.key === 'Escape') { closePreview(); return; }
        if (event.key === 'ArrowLeft') { navigatePreview(-1); return; }
        if (event.key === 'ArrowRight') { navigatePreview(1); return; }
        if (event.key === '+' || event.key === '=') { zoomPreview(1.25); return; }
        if (event.key === '-') { zoomPreview(0.8); return; }
        trapPreviewFocus(event);
        return;
    }

    const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (isTyping) return;

    const ctrlOrCmd = event.ctrlKey || event.metaKey;

    if (ctrlOrCmd && event.key.toLowerCase() === 'a') {
        if (state.pages.length === 0) return;
        event.preventDefault();
        state.pages.forEach((p) => state.selectedIds.add(p.id));
        updateSelectionUI();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedIds.size > 0) {
        event.preventDefault();
        deleteSelected();
    } else if (ctrlOrCmd && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
    }
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

bulkRotateBtn.addEventListener('click', rotateSelected);
bulkDeleteBtn.addEventListener('click', deleteSelected);
bulkClearBtn.addEventListener('click', () => {
    state.selectedIds.clear();
    updateSelectionUI();
});

// In-place confirm-on-click instead of a blocking native confirm().
let resetConfirmTimeout = null;
resetBtn.addEventListener('click', () => {
    if (resetBtn.dataset.confirming === 'true') {
        clearTimeout(resetConfirmTimeout);
        resetBtn.dataset.confirming = 'false';
        resetBtn.textContent = 'Réinitialiser';
        resetAll();
        return;
    }
    resetBtn.dataset.confirming = 'true';
    resetBtn.textContent = 'Confirmer ?';
    resetConfirmTimeout = setTimeout(() => {
        resetBtn.dataset.confirming = 'false';
        resetBtn.textContent = 'Réinitialiser';
    }, 3000);
});

fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
});

['dragenter', 'dragover'].forEach((evt) => {
    dropZone.addEventListener(evt, (event) => {
        event.preventDefault();
        dropZone.classList.add('drag-active');
    });
});

['dragleave', 'drop'].forEach((evt) => {
    dropZone.addEventListener(evt, (event) => {
        event.preventDefault();
        dropZone.classList.remove('drag-active');
    });
});

dropZone.addEventListener('drop', (event) => {
    if (event.dataTransfer.files.length) handleFiles(event.dataTransfer.files);
});

window.addEventListener('beforeunload', (event) => {
    if (state.sources.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
});

async function getPdfLibDoc(source) {
    if (!source.pdfLibDocPromise) {
        source.pdfLibDocPromise = PDFDocument.load(source.bytes);
    }
    return source.pdfLibDocPromise;
}

exportBtn.addEventListener('click', async () => {
    if (totalPages() === 0) return;

    setLoading(true, 'Génération du PDF…');
    try {
        const output = await PDFDocument.create();

        // Group by source doc for a single copyPages pass each, while keeping final page order.
        const bySource = new Map();
        state.pages.forEach((page, index) => {
            if (!bySource.has(page.sourceId)) bySource.set(page.sourceId, []);
            bySource.get(page.sourceId).push({ page, index });
        });

        const copiedByPageId = new Map();
        for (const [sourceId, entries] of bySource) {
            const source = state.sources.get(sourceId);
            const pdfLibDoc = await getPdfLibDoc(source);
            const indices = entries.map((e) => e.page.pageIndexInSource);
            const copiedPages = await output.copyPages(pdfLibDoc, indices);
            entries.forEach((e, i) => copiedByPageId.set(e.page.id, copiedPages[i]));
        }

        const pageCount = state.pages.length;
        state.pages.forEach((page) => {
            const copiedPage = copiedByPageId.get(page.id);
            if (page.rotation !== 0) {
                copiedPage.setRotation(degrees((copiedPage.getRotation().angle + page.rotation) % 360));
            }
            output.addPage(copiedPage);
        });

        const pdfBytes = await output.save();
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const name = (filenameInput.value || 'document').replace(/\.pdf$/i, '');

        const link = document.createElement('a');
        link.href = url;
        link.download = `${name}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        showToast(`PDF généré : ${pageCount} page${pageCount > 1 ? 's' : ''}.`, 'success', false);
    } catch (e) {
        showToast(`La génération du PDF a échoué : ${e.message}`);
    } finally {
        setLoading(false);
    }
});

render();
