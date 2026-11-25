// Shared helpers for the benchmark scripts. Node built-ins only.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(BENCH);
export const CACHE = join(BENCH, 'cache');
export const RESULTS = join(BENCH, 'results');
export const DOWNLOADS = join(BENCH, 'downloads.json');
export const RUNS = join(BENCH, 'runs.json');
export const FINDINGS_CSV = join(BENCH, 'findings.csv');
export const PRIVATE = join(BENCH, 'PRIVATE-disclosures.md');

/** correct: a real problem. intended: read correctly, but the app chose it. false-alarm: the tool misread it. */
export const VERDICTS = ['correct', 'intended', 'false-alarm', 'cant-tell'];

export function loadApps() {
  return JSON.parse(readFileSync(join(BENCH, 'apps.json'), 'utf8')).apps;
}

export const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);

/** `--only a,b,c` limits a script to those app ids (the pilot). Unknown ids are an error, not silently ignored. */
export function selectApps(argv) {
  const apps = loadApps();
  const i = argv.indexOf('--only');
  if (i < 0) return apps;
  const ids = (argv[i + 1] ?? '').split(',').filter(Boolean);
  const unknown = ids.filter((id) => !apps.some((a) => a.id === id));
  if (ids.length === 0 || unknown.length > 0) throw new Error(`--only: unknown app id(s): ${unknown.join(', ') || '(none given)'}`);
  return apps.filter((a) => ids.includes(a.id));
}

/** One cache file per app and asset, so two apps with the same asset name never collide. */
export const cacheName = (app, asset) => `${app.id}__${asset}`;

export const assetUrl = (app, asset) =>
  `https://github.com/${app.repo}/releases/download/${encodeURIComponent(app.tag)}/${encodeURIComponent(asset)}`;

// ---------------------------------------------------------------- CSV (RFC 4180)

export const CSV_COLUMNS = ['app', 'tag', 'file', 'rule', 'severity', 'count', 'evidence', 'location', 'suggested_verdict', 'reason', 'verdict'];

const quote = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows, columns = CSV_COLUMNS) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => quote(r[c])).join(','))].join('\n') + '\n';
}

export function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); records.push(record); field = ''; record = [];
    } else field += c;
  }
  if (field !== '' || record.length > 0) { record.push(field); records.push(record); }
  const [header = [], ...body] = records.filter((r) => r.length > 1 || r[0] !== '');
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
