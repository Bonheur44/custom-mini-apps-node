import puppeteer from 'puppeteer-core';
import { ToolError } from '../lib/errors.js';

// Desktop-like width, since most input HTML is designed for screen, not Chrome's 800×600 default.
const VIEWPORT_WIDTH = 1280;

// Chrome refuses PDF pages taller than ~200in; beyond this we fall back to A4 pagination.
const MAX_PAGE_HEIGHT = 18000;

// Gap below the default viewport past which we treat the document as defining its own width.
const WIDTH_DETECTION_THRESHOLD = 40;

// Vercel sets VERCEL=1; AWS Lambda (which Vercel functions run on) sets the second one.
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

let browserPromise = null;

/**
 * Where Chrome comes from depends on the host. On a serverless function, `@sparticuz/chromium`
 * unpacks a trimmed Linux build into /tmp. Anywhere else, `PUPPETEER_EXECUTABLE_PATH` wins,
 * then the Chrome that the `puppeteer` dev dependency downloaded on `npm install`. Both
 * `@sparticuz/chromium` and `puppeteer` are imported lazily so the other host's package is never
 * loaded (or required to be installed).
 */
async function launchOptions() {
    if (isServerless) {
        const { default: chromium } = await import('@sparticuz/chromium');

        return { headless: true, args: chromium.args, executablePath: await chromium.executablePath() };
    }

    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath) {
        try {
            executablePath = await (await import('puppeteer')).default.executablePath();
        } catch {
            throw new ToolError('Chrome est introuvable : installez la dépendance de développement `puppeteer` ou renseignez PUPPETEER_EXECUTABLE_PATH.');
        }
    }

    return { headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
}

/** One shared headless Chrome, relaunched if it dies; launching per request costs ~1s. */
async function browser() {
    if (browserPromise) {
        const current = await browserPromise.catch(() => null);
        if (current && current.connected) return current;
    }

    browserPromise = launchOptions().then((options) => puppeteer.launch(options));

    return browserPromise;
}

export async function closeBrowser() {
    if (!browserPromise) return;
    const current = await browserPromise.catch(() => null);
    browserPromise = null;
    await current?.close();
}

/** @returns {Promise<[number, ?number]>} [width, height] — height null means "use A4 pagination". */
async function measure(page) {
    let raw;
    try {
        // Wait for web fonts, or height gets measured with a shorter fallback font (phantom page).
        raw = await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;

            return `${Math.ceil(document.body.getBoundingClientRect().width)},${Math.ceil(document.documentElement.scrollHeight)}`;
        });
    } catch {
        return [VIEWPORT_WIDTH, null];
    }

    const [contentWidth = 0, contentHeight = 0] = raw.split(',').map((n) => parseInt(n, 10) || 0);

    if (contentHeight <= 0 || contentHeight > MAX_PAGE_HEIGHT) {
        return [VIEWPORT_WIDTH, null];
    }

    const hasNarrowerContent = contentWidth > 0 && contentWidth <= VIEWPORT_WIDTH - WIDTH_DETECTION_THRESHOLD;

    return [hasNarrowerContent ? contentWidth : VIEWPORT_WIDTH, contentHeight];
}

/**
 * @param {string} html
 * @param {'continuous'|'paginated'} layout  'continuous': single page sized to content. 'paginated': standard A4.
 * @returns {Promise<Uint8Array>}
 */
export async function convert(html, layout = 'continuous') {
    let page;

    try {
        page = await (await browser()).newPage();
        await page.setViewport({ width: VIEWPORT_WIDTH, height: 800 });
        // Without this, Chrome applies its own "print" media reset (hidden backgrounds, altered links).
        await page.emulateMediaType('screen');
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60_000 });
        // Neutralizes <html>'s background so a design's on-screen canvas color doesn't leak
        // through as residual vertical margin once the page is sized to content width.
        await page.addStyleTag({ content: 'html { background-color: #ffffff !important; }' });

        const [width, height] = layout === 'paginated' ? [VIEWPORT_WIDTH, null] : await measure(page);

        const options = { printBackground: true, timeout: 60_000 };

        return height !== null
            ? await page.pdf({ ...options, width: `${width}px`, height: `${height}px` })
            : await page.pdf({ ...options, format: 'A4' });
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(`Chrome n'a pas pu générer le PDF : ${error.message}`, { cause: error });
    } finally {
        await page?.close().catch(() => {});
    }
}
