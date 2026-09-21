/**
 * Rejoins syllable-hyphenated lyrics from a score extraction ("Al- le- lu- ia") into readable
 * words. Heuristic, not calibrated against real scores yet — the result is always shown as an
 * editable draft, never injected directly.
 */
export function normalizeLyrics(text) {
    let out = String(text ?? '').replace(/\r\n?/g, '\n');

    // Rejoins syllables split by a hyphen + space (music notation convention), leaving real
    // hyphenated words ("avant-garde") alone since they have no trailing space.
    out = out.replace(/-\s+/gu, '');

    // Collapses horizontal whitespace only, preserving line breaks (verse separators).
    out = out.replace(/[ \t]+/gu, ' ');

    out = out.split('\n').map((line) => line.trimEnd()).join('\n');

    // Collapses consecutive blank lines to one (verse separator).
    out = out.replace(/\n{3,}/g, '\n\n');

    return out.trim();
}

/** Does the text likely contain an explicitly marked chorus ("R.", "R/", "Refrain")? */
export function hasMarkedChorus(text) {
    return /^\s*(R[./]|Refrain\s*:?)/imu.test(String(text ?? ''));
}
