import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { ValidationError } from './errors.js';
import { removeFile } from './tempDir.js';

const MB = 1024 * 1024;

/**
 * Browsers send multipart filenames as raw UTF-8 bytes, but busboy (under multer) decodes them
 * as latin1 — "été" arrives as "Ã©tÃ©". Re-decoding is only applied when it yields valid UTF-8.
 */
function decodeFilename(name) {
    if (!/[\u0080-ÿ]/.test(name)) return name;

    const decoded = Buffer.from(name, 'latin1').toString('utf8');

    return decoded.includes('�') ? name : decoded;
}

/**
 * Single-file upload to the OS temp folder (the PDF tools need a real path to hand to Poppler).
 * `extensions` is checked on the client-provided name; the route must unlink `req.file.path`
 * when done.
 */
export function singleUpload(field, { maxMb, extensions, requiredMessage, typeMessage }) {
    const upload = multer({
        dest: os.tmpdir(),
        limits: { fileSize: maxMb * MB, files: 1 },
    }).single(field);

    return (req, res, next) => {
        upload(req, res, (error) => {
            if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
                return next(ValidationError.single(field, `Le fichier ne doit pas dépasser ${maxMb} Mo.`));
            }
            if (error) return next(error);

            if (req.file) {
                req.file.originalname = decodeFilename(req.file.originalname);

                const ext = path.extname(req.file.originalname).toLowerCase().slice(1);
                if (!extensions.includes(ext)) {
                    removeFile(req.file.path);
                    req.file = undefined;

                    return next(ValidationError.single(field, typeMessage));
                }
            } else if (requiredMessage) {
                return next(ValidationError.single(field, requiredMessage));
            }

            next();
        });
    };
}
