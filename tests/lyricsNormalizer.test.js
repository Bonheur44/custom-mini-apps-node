import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMarkedChorus, normalizeLyrics } from '../public/js/lyrics-normalizer.js';

test('rejoins syllables split by hyphen + space', () => {
    assert.equal(normalizeLyrics('Al- lé- lu- ia'), 'Alléluia');
});

test('leaves real hyphenated words alone', () => {
    assert.equal(normalizeLyrics('avant-garde'), 'avant-garde');
});

test('collapses horizontal whitespace but keeps line breaks', () => {
    assert.equal(normalizeLyrics('Un   deux\t trois \nquatre'), 'Un deux trois\nquatre');
});

test('collapses runs of blank lines to a single verse separator', () => {
    assert.equal(normalizeLyrics('Couplet 1\n\n\n\nCouplet 2\r\n\r\n\r\nCouplet 3'), 'Couplet 1\n\nCouplet 2\n\nCouplet 3');
});

test('detects an explicitly marked chorus', () => {
    assert.equal(hasMarkedChorus('R. Gloire à Dieu'), true);
    assert.equal(hasMarkedChorus('Refrain :\nGloire'), true);
    assert.equal(hasMarkedChorus('Rien ici'), false);
});
