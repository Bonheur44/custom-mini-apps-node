import fs from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, ytDlp } from '../lib/binaries.js';
import { ToolError } from '../lib/errors.js';
import { ProcessFailure, run } from '../lib/process.js';

const INFO_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 900_000;

function maxFilesizeMb() {
    return Number(process.env.DOWNLOADER_MAX_FILESIZE_MB) || 1024;
}

/**
 * yt-dlp prefixes its user-facing errors (invalid URL, unsupported site, private video...) with
 * "ERROR: " — only that last relevant line is kept rather than the full, verbose trace.
 */
function errorMessage(stderr) {
    const line = stderr.split('\n').reverse().find((l) => l.includes('ERROR:'));

    return line
        ? line.slice(line.indexOf('ERROR:') + 'ERROR:'.length).trim()
        : 'Le téléchargement a échoué — URL invalide ou site non supporté.';
}

async function runYtDlp(args, timeout) {
    try {
        return await run(ytDlp(), args, { timeout, maxBuffer: 256 * 1024 * 1024 });
    } catch (error) {
        if (error instanceof ProcessFailure && error.missing) {
            throw new ToolError('yt-dlp est introuvable sur cette machine (`winget install yt-dlp.yt-dlp`), puis redémarrez le serveur.', { cause: error });
        }
        if (error instanceof ProcessFailure) {
            throw new ToolError(errorMessage(error.stderr || error.message), { cause: error });
        }
        throw error;
    }
}

/** @returns {Promise<{ title: string, channel: ?string, duration: ?number, thumbnail: ?string, url: string }>} */
export async function fetchInfo(url) {
    const { stdout } = await runYtDlp([
        '--ignore-config',
        '--no-config-locations',
        '--no-playlist',
        '--skip-download',
        '--dump-single-json',
        '--no-warnings',
        '--socket-timeout', '15',
        '--',
        url,
    ], INFO_TIMEOUT_MS);

    let data;
    try {
        data = JSON.parse(stdout);
    } catch {
        data = null;
    }

    if (!data || typeof data.title !== 'string') {
        throw new ToolError('Impossible de lire les informations de cette vidéo.');
    }

    return {
        title: data.title,
        channel: data.uploader ?? data.channel ?? null,
        duration: data.duration ?? null,
        thumbnail: data.thumbnail ?? null,
        url: data.webpage_url ?? url,
    };
}

function formatArguments(type, quality) {
    if (type === 'audio') {
        return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    }

    const maxHeight = { 1080: 1080, 720: 720, 480: 480 }[quality] ?? null;

    if (maxHeight === null) {
        return ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'];
    }

    return ['-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]`, '--merge-output-format', 'mp4'];
}

/**
 * Downloads the video (or audio) into `outputDir` and returns the produced file's path. yt-dlp
 * names the file after the video's title, so it's found by listing the folder afterwards —
 * the folder only ever contains this one download.
 */
export async function download(url, type, quality, outputDir) {
    await runYtDlp([
        '--ignore-config',
        '--no-config-locations',
        '--no-exec',
        '--no-playlist',
        '--no-warnings',
        '--windows-filenames',
        '--socket-timeout', '15',
        '--max-filesize', `${maxFilesizeMb()}M`,
        '--ffmpeg-location', ffmpeg(),
        '-o', path.join(outputDir, '%(title)s.%(ext)s'),
        ...formatArguments(type, quality),
        '--',
        url,
    ], DOWNLOAD_TIMEOUT_MS);

    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const file = entries.find((entry) => entry.isFile());

    if (!file) {
        throw new ToolError('Le téléchargement n’a produit aucun fichier.');
    }

    return path.join(outputDir, file.name);
}
