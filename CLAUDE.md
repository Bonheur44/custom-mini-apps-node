# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node 22+ / Express 5 port of the sibling Laravel app (`../laravel`, see its own CLAUDE.md for
the full background). Same portal, same URLs, same French UI, same design system — six of the
Laravel tools, minus the two that need a database or a separate server (Feuillet de messe,
Recherche de numéro). It is built to deploy on **Vercel** (zero-config Express) as well as on a
plain server, which drove the split below: everything that can run in the browser does.

| Tool | Screen | Runs | Backed by |
|---|---|---|---|
| HTML → PDF | `/convert` | server, `POST /api/convert` | `puppeteer-core` + headless Chrome (see below) |
| Éditeur de pages PDF | `/pdf-editor` | browser | `pdfjs-dist` + `pdf-lib` |
| Extracteur de paroles | `/lyrics-extractor` | browser | `pdfjs-dist` (render) + `tesseract.js` (OCR, WebAssembly, from jsDelivr) |
| Téléchargeur vidéo/audio | `/video-downloader` | server, `POST /api/downloader/info`, `POST /api/downloader/download` | `yt-dlp` + `ffmpeg` CLI — **not available on Vercel** |
| Extracteur de pages PDF | `/pdf-pages` | browser | `pdf-lib` |
| Découpeur de PDF | `/pdf-split` | browser | `pdf-lib` + `fflate` (ZIP) |

Everything is stateless; there is no database and no auth.

**Code is in English; user-facing text is in French** — same rule as the Laravel app. Error
messages thrown from services are French because they go straight to the UI.

## Commands

- Install: `npm install` — the `postinstall` script copies the browser builds into
  `public/vendor/` (gitignored), and the `puppeteer` dev dependency downloads a local Chrome
- Run: `npm start` (port 3000, or `PORT` in `.env`); `npm run dev` restarts on file changes
- Tests: `npm test` (`node --test`, no external binaries are exercised)
- One test file: `node --test tests/api.test.js`; one test by name:
  `node --test --test-name-pattern="slug" "tests/**/*.test.js"` (a bare directory argument fails)
- No linter/formatter is configured; match the 4-space, single-quote style of the existing files.
- Configuration is `.env` only (loaded by `dotenv` in `server.js`); `.env.example` documents
  every variable.

The git repository root is the parent folder (`../`), which holds both `laravel/` and `node/`;
paths in git commands are relative to that root, not to this folder.

## Architecture

- `server.js` — boots `src/app.js`. On a real server it disables Node's 5-minute request timeout
  (yt-dlp downloads can run longer) and closes the shared Chrome on SIGINT/SIGTERM. On Vercel
  `app.listen` is intercepted, so nothing in it may assume a real `http.Server`.
- `src/app.js` — one `res.sendFile` route per screen (`views/*.html`), `express.static` over
  `public/`, the `/api` router, and the error handler that maps `ValidationError` →
  `422 { message, errors: { field: [...] } }` (same shape as Laravel form requests, which the
  screens' JS already parses) and `ToolError` → `422 { message }`.
- `src/routes/api.js` — the two server-side tools. Uploads go through `src/lib/uploads.js`
  (multer to the OS temp dir + extension check); the handler unlinks `req.file.path` in a
  `finally`. Downloads use `sendAndClean()`: `res.download()` then remove the whole per-request
  temp dir in its callback.
- `src/services/*.js` — one module per server-side tool. `src/lib/binaries.js` resolves yt-dlp
  and ffmpeg (env var → Windows auto-detect → PATH); `src/lib/process.js` wraps `execFile`,
  decodes Windows-1252 stderr so French console errors don't reach the UI as mojibake, and
  rejects with `ProcessFailure`, whose `missing` flag (ENOENT) is what the service uses to pick
  the "install it" message over the "it failed: <stderr>" one. Every service rethrows a French
  `ToolError`; nothing below the routes throws raw errors.
- `public/js/*.js` — the browser-side tools, one ES module per screen (`pdf-pages.js`,
  `pdf-split.js`, `ocr.js`, `pdf-editor.js`), plus two modules shared with the server:
  `slug.js` (imported by `api.js`) and `lyrics-normalizer.js` (used by `ocr.js`, unit-tested).
  Each view keeps only its theme toggle inline and loads its module with
  `<script type="module" src="/js/<tool>.js">`. Validation messages mirror the ones the
  former server routes produced, so the UI copy is unchanged.

**Views started as copies of the Laravel Blade templates**, converted to static HTML. The three
browser-side tools (`pdf-pages`, `pdf-split`, `ocr`) have since diverged from their Laravel
counterparts, which still post to the server. When a screen changes in one project, port the
change to the other by hand — there is no shared source.

**No bundler**: the screens import `/vendor/pdfjs/pdf.mjs`, `/vendor/pdfjs/pdf.worker.mjs`,
`/vendor/pdf-lib/pdf-lib.esm.js` and `/vendor/fflate/fflate.esm.js`, which
`scripts/copy-vendor.js` copies from `node_modules` into `public/vendor/` on install (all ship
self-contained ESM builds). Tesseract is the exception: `ocr.js` imports `tesseract.js` from
jsDelivr, and its worker, WebAssembly core and `fra` model come from that library's default
CDNs — self-hosting would mean serving ~20 MB of variants. `pdf-editor.js` is the Laravel
`resources/js/pdf-editor.js` with its imports rewritten to those `/vendor/` paths and the worker
URL hard-coded; the rest is identical, so `diff` against the Laravel copy checks the port.

**HTML → PDF** (`src/services/htmlToPdf.js`) reproduces the Laravel Browsershot path: 1280px
viewport, `screen` media, white `<html>` background, and for `layout=continuous` a single page
sized to the measured content (after `document.fonts.ready`, capped at 18000px before falling
back to A4). One Chrome instance is launched lazily and reused; `closeBrowser()` on shutdown.
Chrome itself comes from `@sparticuz/chromium` when `VERCEL`/`AWS_LAMBDA_FUNCTION_NAME` is set,
otherwise from `PUPPETEER_EXECUTABLE_PATH` or the `puppeteer` dev dependency's download (note
`executablePath()` is async in this Puppeteer). `@sparticuz/chromium`'s major version must
match the Chrome pinned by `puppeteer-core` (both 153 today); bump them together.

**Multipart filenames**: busboy (under multer) decodes filenames as latin1, so "été" arrives as
"Ã©tÃ©". `uploads.js` re-decodes to UTF-8.

## Vercel

Zero-config: Vercel detects `server.js` as the Express entrypoint and runs the whole app as one
Fluid-compute function. What that imposes, and how the code accounts for it:

- `express.static()` is ignored; only `public/**` is served (by the CDN, at the same paths). That
  is why vendor builds are copied into `public/vendor/` rather than served from `node_modules`.
- The bundle only contains files the tracer can see. The view paths in `app.js` are
  `new URL('../views/x.html', import.meta.url)` literals for that reason — a `path.join` with a
  variable would get pruned.
- Request bodies over 4.5 MB are rejected before the app sees them, hence the 4 MB cap on the
  `/convert` upload and the decision to do every PDF tool in the browser.
- yt-dlp/ffmpeg cannot exist there. `requireServer()` in `api.js` turns the downloader into a
  clear 422 when `VERCEL` is set instead of a "command not found" hint about winget.
- Set `PUPPETEER_SKIP_DOWNLOAD=true` in the Vercel project's environment so the `puppeteer`
  dev dependency doesn't download a 150 MB Chrome during each build.

The Vercel deployment itself has not been exercised from this repo yet; the local run and the
browser tools have.

## System dependencies (server hosting only)

yt-dlp and ffmpeg are external programs (`winget install yt-dlp.yt-dlp`). `src/lib/binaries.js`
finds each one in this order: explicit env var (`DOWNLOADER_YTDLP_BINARY`,
`DOWNLOADER_FFMPEG_BINARY`), then the Windows install location (winget's `Links` shim for
yt-dlp, its versioned `Packages` folder for ffmpeg), then the bare command name. The middle
step exists because a binary installed after the server started isn't on that process's PATH.

A missing binary surfaces as a 422 with an install hint, not a 500 — keep it that way.

## Testing

`node --test` over `tests/*.test.js`: pure-function tests (`lyrics-normalizer`, `slug`) and
HTTP-level tests that boot the Express app on a random port and call it with the built-in
`fetch`/`FormData`: screens and static modules are served, validation rules, the removed
server-side PDF routes stay 404, and the Vercel refusal of the downloader. Nothing shells out
to a binary or launches Chrome in tests — HTML → PDF and the browser-side tools are verified
by hand (or by driving the running app with Puppeteer). New validation rules belong in
`api.test.js`; anything that would reach yt-dlp or Chrome does not belong in the suite.
