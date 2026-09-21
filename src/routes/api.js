import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { ToolError, ValidationError } from '../lib/errors.js';
import { slug } from '../../public/js/slug.js';
import { makeTempDir, removeDir, removeFile } from '../lib/tempDir.js';
import { singleUpload } from '../lib/uploads.js';
import * as htmlToPdf from '../services/htmlToPdf.js';
import * as ytDlp from '../services/ytDlp.js';

export const api = Router();

/**
 * Streams a file as an attachment, then removes its whole temp directory — intermediates
 * (yt-dlp fragments) live next to the final file, so the directory is the unit of cleanup, not
 * the file.
 */
function sendAndClean(res, filePath, downloadName, tempDir, headers = {}) {
    res.set(headers);
    res.download(filePath, downloadName, () => removeDir(tempDir));
}

function validUrl(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw ValidationError.single('url', 'Merci de renseigner une URL.');
    }
    if (value.length > 2048) {
        throw ValidationError.single('url', 'Cette URL est trop longue.');
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw ValidationError.single('url', 'Cette URL n’est pas valide.');
    }

    // Generic yt-dlp "extractor": an unrestricted scheme would let it be pointed at local resources.
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw ValidationError.single('url', 'Seules les URL http:// ou https:// sont acceptées.');
    }

    return value;
}

// ---- HTML → PDF -------------------------------------------------------------------------------

api.post(
    '/convert',
    singleUpload('file', {
        // Vercel rejects request bodies above 4.5 MB before they reach the app.
        maxMb: 4,
        extensions: ['html', 'htm', 'txt'],
        typeMessage: 'Le fichier doit être un .html, .htm ou .txt.',
    }),
    async (req, res) => {
        const hasHtml = typeof req.body.html === 'string' && req.body.html.trim() !== '';
        const hasFile = Boolean(req.file);

        try {
            if (!hasHtml && !hasFile) {
                throw ValidationError.single('html', 'Vous devez fournir soit le champ "html", soit un fichier "file".');
            }
            if (hasHtml && hasFile) {
                throw ValidationError.single('html', 'Fournissez soit "html", soit "file", pas les deux.');
            }

            const html = hasFile ? await fs.readFile(req.file.path, 'utf8') : req.body.html;
            const layout = req.body.layout === 'paginated' ? 'paginated' : 'continuous';
            const pdf = await htmlToPdf.convert(html, layout);
            const filename = `${slug(req.body.filename) || 'document'}.pdf`;

            res.set({
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${filename}"`,
            });
            res.send(Buffer.from(pdf));
        } finally {
            await removeFile(req.file?.path);
        }
    },
);

// ---- Téléchargeur vidéo/audio ------------------------------------------------------------------

/**
 * yt-dlp and ffmpeg are system programs: they exist on a machine or container this app is
 * installed on, never in a Vercel function. Saying so beats a "command not found" hint about
 * winget on a Linux box.
 */
function requireServer() {
    if (process.env.VERCEL) {
        throw new ToolError('Le téléchargeur n’est pas disponible sur cet hébergement : il a besoin d’un serveur avec yt-dlp et ffmpeg installés.');
    }
}

api.post('/downloader/info', async (req, res) => {
    requireServer();
    const url = validUrl(req.body?.url);
    res.json(await ytDlp.fetchInfo(url));
});

api.post('/downloader/download', async (req, res) => {
    requireServer();
    const url = validUrl(req.body?.url);
    const type = req.body?.type === 'audio' ? 'audio' : 'video';
    const quality = ['1080', '720', '480'].includes(String(req.body?.quality)) ? String(req.body.quality) : 'best';

    const tempDir = await makeTempDir('downloader');

    let filePath;
    try {
        filePath = await ytDlp.download(url, type, quality, tempDir);
    } catch (error) {
        await removeDir(tempDir);
        throw error;
    }

    sendAndClean(res, filePath, path.basename(filePath), tempDir);
});
