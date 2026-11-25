import { describe, expect, it } from 'vitest';
import { isHermesBytecode, readHermesStrings } from '../src/formats/hermes.js';
import { hbc } from './helpers/fixtures.js';

const STRINGS = ['global', 'https://api.staging.example.com/v1', 'Kamera für Fotos ✓', 'x'.repeat(300)];
// Assembled at runtime so no file contains a complete key pattern.
const FAKE_KEY = 'sk_' + 'live_' + '0'.repeat(28);
const IDENTIFIERS = ['api', 'key', 'print', '$uni_2'];

describe('isHermesBytecode', () => {
  it('detects the Hermes magic number', () => {
    expect(isHermesBytecode(hbc({ strings: ['a'] }))).toBe(true);
    expect(isHermesBytecode(Buffer.from('var __DEV__=false;'))).toBe(false);
    expect(isHermesBytecode(Buffer.alloc(3))).toBe(false);
  });
});

describe('readHermesStrings', () => {
  it('reads every string, including UTF-16 and overflow entries (12-byte function headers, v98)', () => {
    const result = readHermesStrings(hbc({ strings: STRINGS, identifiers: IDENTIFIERS, functionCount: 3 }));
    expect(result).toEqual({ version: 98, strings: [...STRINGS, ...IDENTIFIERS], approximate: false });
  });

  it('reads the older layout with 16-byte function headers', () => {
    const result = readHermesStrings(
      hbc({ strings: STRINGS, identifiers: IDENTIFIERS, version: 94, functionCount: 3, functionHeaderSize: 16 }),
    );
    expect(result).toEqual({ version: 94, strings: [...STRINGS, ...IDENTIFIERS], approximate: false });
  });

  it('accepts property keys that are not JS identifiers, as real hermesc output has them', () => {
    // Identifier table of hermesc v98 for `{ 'Content-Type': …, '@@iterator': …, 'x y': … }`, a private field and unicode keys.
    const identifiers = ['o', '#priv', '@@iterator', 'Content-Type', 'x y', 'x-api-key', 'é-ü', '123'];
    const result = readHermesStrings(hbc({ strings: ['application/json'], identifiers }));
    expect(result).toEqual({ version: 98, strings: ['application/json', ...identifiers], approximate: false });
  });

  it('accepts a lone NUL property key, which real bundles have (Mattermost, Joplin, Rocket.Chat, PocketPal)', () => {
    const identifiers = ['api', '\u0000', 'key', 'print'];
    for (const [version, functionHeaderSize] of [[98, 12], [96, 16]] as const) {
      const result = readHermesStrings(hbc({ strings: STRINGS, identifiers, version, functionCount: 3, functionHeaderSize }));
      expect(result).toEqual({ version, strings: [...STRINGS, ...identifiers], approximate: false });
    }
  });

  it('still rejects a layout guess whose identifiers are full of NUL bytes', () => {
    const identifiers = Array.from({ length: 40 }, (_, i) => `id\u0000${i}`);
    expect(readHermesStrings(hbc({ strings: ['a'], identifiers })).approximate).toBe(true);
  });

  it('falls back to printable runs when no known layout fits', () => {
    const file = hbc({ strings: [FAKE_KEY], identifiers: ['key'], functionHeaderSize: 20 });
    const result = readHermesStrings(file);
    expect(result.approximate).toBe(true);
    expect(result.strings.some((s) => s.includes(FAKE_KEY))).toBe(true);
  });

  it('falls back on a truncated file instead of throwing', () => {
    const file = hbc({ strings: STRINGS, identifiers: IDENTIFIERS });
    expect(readHermesStrings(file.subarray(0, 100)).approximate).toBe(true);
  });
});
