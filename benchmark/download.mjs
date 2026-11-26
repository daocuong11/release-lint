// Downloads each release asset into benchmark/cache/ (gitignored) and records its SHA-256 and size in downloads.json.
// Usage: node benchmark/download.mjs [--only id,id]
// A file already in the cache is re-hashed, not re-downloaded. If a hash differs from the one recorded, the
// script stops: the published asset changed, and the benchmark must not silently switch to another build.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assetUrl, cacheName, CACHE, DOWNLOADS, readJson, selectApps } from './lib.mjs';

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const hash = createHash('sha256');
  const part = `${dest}.part`;
  const tee = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); done(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body), tee, createWriteStream(part));
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
  renameSync(part, dest);
  return hash.digest('hex');
}

async function main() {
  const apps = selectApps(process.argv.slice(2));
  mkdirSync(CACHE, { recursive: true });
  const record = readJson(DOWNLOADS, {});
  let failed = 0;
  for (const app of apps) {
    for (const asset of app.assets) {
      const key = cacheName(app, asset);
      const dest = join(CACHE, key);
      const url = assetUrl(app, asset);
      try {
        const sha256 = existsSync(dest) ? await hashFile(dest) : await download(url, dest);
        const size = statSync(dest).size;
        const known = record[key];
        if (known && known.sha256 !== sha256) {
          throw new Error(`SHA-256 changed for ${key}: recorded ${known.sha256}, now ${sha256}. Not using it.`);
        }
        record[key] = { app: app.id, repo: app.repo, tag: app.tag, asset, url, sha256, size, downloaded: known?.downloaded ?? new Date().toISOString() };
        console.log(`ok    ${key}  ${(size / 1048576).toFixed(1)} MB  sha256 ${sha256.slice(0, 16)}…`);
      } catch (error) {
        failed++;
        console.error(`FAIL  ${key}: ${error.message}`);
      }
    }
  }
  const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(DOWNLOADS, `${JSON.stringify(sorted, null, 2)}\n`);
  if (failed > 0) {
    console.error(`${failed} download(s) failed`);
    process.exitCode = 1;
  }
}

await main();
