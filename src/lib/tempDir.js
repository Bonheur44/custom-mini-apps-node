import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Creates a unique, per-request working directory under the OS temp folder. */
export function makeTempDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

/** Best-effort recursive removal — never throws, since it runs from cleanup paths. */
export async function removeDir(dir) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch {
        // already gone or locked by a straggling process; nothing useful to do
    }
}

/** Best-effort single-file removal (multer uploads). */
export async function removeFile(file) {
    if (!file) return;
    try {
        await fs.unlink(file);
    } catch {
        // ignore
    }
}
