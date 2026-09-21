/**
 * Same output as Laravel's `Str::slug()` for the filenames this app derives from user input.
 * Shared by the browser modules and the server (`api.js` imports it from here).
 */
export function slug(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
