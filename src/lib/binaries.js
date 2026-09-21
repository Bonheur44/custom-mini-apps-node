import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Every external binary is resolved the same way: an explicit env var first, then a
 * Windows-specific auto-detected install location, then the bare command name (PATH). The
 * middle step exists because a freshly `winget`-installed binary isn't on the PATH of a
 * server process started before the install.
 */
function resolve(envVar, detect, fallback) {
    if (process.env[envVar]) return process.env[envVar];

    if (isWindows) {
        const found = detect();
        if (found) return found;
    }

    return fallback;
}

/** Latest (natural-sort) entry of `dir` matching `test`, or null. */
function latestEntry(dir, test) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return null;
    }

    const matches = entries.filter(test).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return matches.length ? path.join(dir, matches.at(-1)) : null;
}

function wingetPackages() {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : null;
}

/** winget keeps a version-independent shim in its "Links" folder. */
export function ytDlp() {
    return resolve(
        'DOWNLOADER_YTDLP_BINARY',
        () => {
            if (!process.env.LOCALAPPDATA) return null;
            const link = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe');

            return fs.existsSync(link) ? link : null;
        },
        'yt-dlp',
    );
}

/** The winget `yt-dlp.FFmpeg` package installs into a versioned folder (`ffmpeg-N.n\bin`). */
export function ffmpeg() {
    return resolve(
        'DOWNLOADER_FFMPEG_BINARY',
        () => {
            const packages = wingetPackages();
            if (!packages) return null;

            const pkg = latestEntry(packages, (entry) => entry.startsWith('yt-dlp.FFmpeg_'));
            if (!pkg) return null;

            const build = latestEntry(pkg, (entry) => entry.startsWith('ffmpeg-'));
            if (!build) return null;

            const binary = path.join(build, 'bin', 'ffmpeg.exe');

            return fs.existsSync(binary) ? binary : null;
        },
        'ffmpeg',
    );
}
