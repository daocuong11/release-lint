const HERMES_MAGIC = 0x1f1903c103bc1fc6n;
const HEADER_SIZE = 128;
/**
 * Size of one function header, which is not stored in the file. 12 bytes in bytecode v98
 * (checked against real hermesc output), 16 bytes in earlier versions. Each guess is validated.
 */
const FUNCTION_HEADER_SIZES = [12, 16] as const;
const OVERFLOW_LENGTH = 0xff;
const IDENTIFIER_KIND_BIT = 0x80000000;
const KIND_COUNT_MASK = 0x7fffffff;
const MIN_PRINTABLE_RUN = 4;
/**
 * The identifier table holds every property key, not only valid JS identifiers (hermesc puts
 * 'Content-Type', '@@iterator', 'x y' there), so the only check on its strings is "almost no NUL bytes":
 * a wrong layout guess decodes garbage full of them. A few real keys do contain one: libraries use the
 * one-character key '\0' (one in each of Mattermost, Joplin, Rocket.Chat and PocketPal), so a handful is allowed.
 */
const NUL = '\u0000';
const MAX_NUL_IDENTIFIERS_MIN = 2;
const MAX_NUL_IDENTIFIERS_SHARE = 0.001;
/** Strings may share storage, so a hostile table could decode the same megabytes millions of times. */
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_FALLBACK_STRINGS = 1_000_000;

export interface HermesStrings {
  /** Hermes bytecode version from the file header. */
  version: number;
  strings: string[];
  /** True when the string table could not be decoded and printable byte runs were used instead. */
  approximate: boolean;
}

export const isHermesBytecode = (buf: Buffer): boolean => buf.length >= 8 && buf.readBigUInt64LE(0) === HERMES_MAGIC;

/**
 * Extracts the string table of a Hermes bytecode bundle with exact string boundaries. If no
 * known layout validates (a newer bytecode version, or a damaged file), falls back to
 * printable ASCII runs and says so, instead of failing the scan.
 */
export function readHermesStrings(buf: Buffer): HermesStrings {
  const version = buf.length >= 12 ? buf.readUInt32LE(8) : 0;
  for (const size of FUNCTION_HEADER_SIZES) {
    const strings = tryLayout(buf, size);
    if (strings) {
      return { version, strings, approximate: false };
    }
  }
  return { version, strings: printableRuns(buf), approximate: true };
}

/** Math.ceil, not `(n + 3) & ~3`: bit operations wrap above 2^31 on corrupt counts. */
const align = (n: number) => Math.ceil(n / 4) * 4;

function tryLayout(buf: Buffer, functionHeaderSize: number): string[] | undefined {
  if (buf.length < HEADER_SIZE) {
    return undefined;
  }
  try {
    const u32 = (at: number) => buf.readUInt32LE(at);
    const [functionCount, kindCount, identifierCount, stringCount, overflowCount, storageSize] = [40, 44, 48, 52, 56, 60].map(u32) as [
      number, number, number, number, number, number,
    ];

    if (identifierCount > stringCount) {
      return undefined;
    }
    let pos = align(HEADER_SIZE + functionCount * functionHeaderSize);
    const identifierIndexes = new Set<number>();
    let total = 0;
    for (let i = 0; i < kindCount; i++) {
      const entry = u32(pos + i * 4);
      const count = entry & KIND_COUNT_MASK;
      if (entry & IDENTIFIER_KIND_BIT) {
        for (let j = 0; j < count && identifierIndexes.size <= identifierCount; j++) identifierIndexes.add(total + j);
      }
      total += count;
    }
    if (total !== stringCount || identifierIndexes.size !== identifierCount) {
      return undefined;
    }

    pos = align(pos + kindCount * 4);
    pos = align(pos + identifierCount * 4);
    const small = pos;
    const overflow = align(small + stringCount * 4);
    const storage = align(overflow + overflowCount * 8);
    if (storage + storageSize > buf.length) {
      return undefined;
    }

    const strings: string[] = [];
    const maxNulIdentifiers = Math.max(MAX_NUL_IDENTIFIERS_MIN, Math.ceil(identifierCount * MAX_NUL_IDENTIFIERS_SHARE));
    let nulIdentifiers = 0;
    let decoded = 0;
    for (let i = 0; i < stringCount; i++) {
      const entry = u32(small + i * 4);
      const utf16 = (entry & 1) === 1;
      let offset = (entry >>> 1) & 0x7fffff;
      let length = entry >>> 24;
      if (length === OVERFLOW_LENGTH) {
        if (offset >= overflowCount) return undefined;
        length = u32(overflow + offset * 8 + 4);
        offset = u32(overflow + offset * 8);
      }
      const byteLength = utf16 ? length * 2 : length;
      decoded += byteLength;
      if (offset + byteLength > storageSize || decoded > MAX_DECODED_BYTES) {
        return undefined;
      }
      const bytes = buf.subarray(storage + offset, storage + offset + byteLength);
      const value = bytes.toString(utf16 ? 'utf16le' : 'latin1');
      if (identifierIndexes.has(i) && value.includes(NUL) && ++nulIdentifiers > maxNulIdentifiers) {
        return undefined;
      }
      strings.push(value);
    }
    return strings;
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

function printableRuns(buf: Buffer): string[] {
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i <= buf.length && runs.length < MAX_FALLBACK_STRINGS; i++) {
    const byte = buf[i];
    const printable = byte !== undefined && byte >= 0x20 && byte <= 0x7e;
    if (printable && start < 0) {
      start = i;
    } else if (!printable && start >= 0) {
      if (i - start >= MIN_PRINTABLE_RUN) runs.push(buf.toString('latin1', start, i));
      start = -1;
    }
  }
  return runs;
}
