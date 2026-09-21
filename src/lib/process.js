import { execFile } from 'node:child_process';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const windows1252 = new TextDecoder('windows-1252');

/**
 * Windows console programs write their messages in the OEM/ANSI code page, not UTF-8, so a
 * French error ("« pdfinfo » n'est pas reconnu...") would otherwise reach the UI as mojibake.
 */
export function toUtf8(buffer) {
    if (buffer.length === 0) return '';

    try {
        return utf8Strict.decode(buffer).trim();
    } catch {
        return windows1252.decode(buffer).trim();
    }
}

export class ProcessFailure extends Error {
    constructor(message, { stderr = '', missing = false, cause } = {}) {
        super(message, { cause });
        this.name = 'ProcessFailure';
        this.stderr = stderr;
        this.missing = missing;
    }
}

/**
 * Runs an external binary and resolves with its decoded stdout/stderr. Rejects with a
 * `ProcessFailure` on a non-zero exit, a timeout, or a binary that can't be found (`missing`).
 */
export function run(binary, args, { timeout = 60_000, maxBuffer = 64 * 1024 * 1024, env } = {}) {
    return new Promise((resolve, reject) => {
        execFile(
            binary,
            args,
            { timeout, maxBuffer, encoding: 'buffer', windowsHide: true, env },
            (error, stdout, stderr) => {
                const err = toUtf8(stderr);

                if (error && error.code === 'ENOENT') {
                    reject(new ProcessFailure(`Commande introuvable : ${binary}`, { missing: true, cause: error }));
                    return;
                }

                if (error) {
                    const reason = error.killed ? 'délai dépassé' : (err || error.message);
                    reject(new ProcessFailure(reason, { stderr: err, cause: error }));
                    return;
                }

                resolve({ stdout: toUtf8(stdout), stderr: err });
            },
        );
    });
}
