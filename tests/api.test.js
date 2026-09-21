import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { slug } from '../public/js/slug.js';

// Validation-only checks: nothing here reaches yt-dlp or Chrome.

let server;
let base;

before(async () => {
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('slug matches Laravel Str::slug for accented input', () => {
    assert.equal(slug('Mon Rapport été'), 'mon-rapport-ete');
    assert.equal(slug('  ---  '), '');
});

test('every screen is served as HTML', async () => {
    for (const route of ['/', '/convert', '/pdf-editor', '/lyrics-extractor', '/video-downloader', '/pdf-pages', '/pdf-split']) {
        const res = await fetch(`${base}${route}`);
        assert.equal(res.status, 200, route);
        assert.match(res.headers.get('content-type'), /text\/html/, route);
    }
});

test('browser modules and vendor builds are served from public/', async () => {
    for (const path of ['/js/pdf-pages.js', '/js/pdf-split.js', '/js/ocr.js', '/js/slug.js', '/vendor/pdf-lib/pdf-lib.esm.js', '/vendor/pdfjs/pdf.mjs', '/vendor/fflate/fflate.esm.js']) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get('content-type'), /javascript/, path);
    }
});

test('unknown route answers JSON 404', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { message: 'Ressource introuvable.' });
});

test('convert requires exactly one of html or file', async () => {
    const res = await fetch(`${base}/api/convert`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.errors.html[0].includes('soit le champ "html"'));
});

test('convert rejects non-HTML uploads', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['%PDF-1.4']), 'not.pdf');
    const res = await fetch(`${base}/api/convert`, { method: 'POST', body: fd });
    assert.equal(res.status, 422);
    assert.deepEqual((await res.json()).errors, { file: ['Le fichier doit être un .html, .htm ou .txt.'] });
});

test('removed server-side PDF tools are gone', async () => {
    for (const route of ['/api/ocr/extract', '/api/pdf-pages/extract', '/api/pdf-split']) {
        const res = await fetch(`${base}${route}`, { method: 'POST', body: new FormData() });
        assert.equal(res.status, 404, route);
    }
});

test('downloader only accepts http(s) URLs', async () => {
    const res = await fetch(`${base}/api/downloader/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    assert.equal(res.status, 422);
    assert.deepEqual((await res.json()).errors, { url: ['Seules les URL http:// ou https:// sont acceptées.'] });
});

test('downloader is refused on Vercel before any validation', async () => {
    process.env.VERCEL = '1';
    try {
        const res = await fetch(`${base}/api/downloader/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/video' }),
        });
        assert.equal(res.status, 422);
        assert.match((await res.json()).message, /pas disponible sur cet hébergement/);
    } finally {
        delete process.env.VERCEL;
    }
});
