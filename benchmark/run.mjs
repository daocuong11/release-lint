// Builds release-lint from this repo and runs it on every downloaded build.
// Usage: node benchmark/run.mjs [--only id,id]
// Raw JSON reports go to benchmark/results/<app>__<asset>.json; outcomes, timings and versions to runs.json.
// Outcomes: "scanned" (a report), "unreadable" (release-lint refused the file with a clean exit 2),
// "crash" (anything else: unexpected error, bad JSON, timeout). Nothing is skipped.
// Only counts are printed here: evidence stays in the report files, masked exactly as release-lint wrote it.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cacheName, CACHE, DOWNLOADS, RESULTS, ROOT, RUNS, readJson, selectApps } from './lib.mjs';

const TIMEOUT_MS = 10 * 60 * 1000;
const BIN = join(ROOT, 'dist', 'bin.js');
/** An empty working directory, so no release-lint.config.json changes the results. */
const EMPTY_CWD = join(CACHE, '.empty-cwd');

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function toolInfo() {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // Only src/ and package files change the tool; the benchmark folder itself does not count as "dirty".
  const dirty = git('status', '--porcelain', '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json') !== '';
  return { version, commit: git('rev-parse', 'HEAD'), toolSourceModified: dirty, node: process.version };
}

function classify(result) {
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return { outcome: 'crash', detail: `killed (${result.signal ?? 'timeout'})` };
  const stderr = result.stderr.trim();
  if (result.status === 0) {
    try {
      return { outcome: 'scanned', report: JSON.parse(result.stdout) };
    } catch {
      return { outcome: 'crash', detail: 'exit 0 but stdout is not JSON' };
    }
  }
  if (result.status === 2 && stderr.startsWith('release-lint: ') && !stderr.includes('unexpected error')) {
    return { outcome: 'unreadable', detail: stderr.split('\n')[0] };
  }
  return { outcome: 'crash', detail: `exit ${result.status}: ${stderr.split('\n')[0] ?? ''}` };
}

function main() {
  const apps = selectApps(process.argv.slice(2));
  const tool = toolInfo();
  const downloads = readJson(DOWNLOADS, {});
  const runs = readJson(RUNS, { runs: {} });
  mkdirSync(RESULTS, { recursive: true });
  mkdirSync(EMPTY_CWD, { recursive: true });
  console.log(`release-lint ${tool.version} @ ${tool.commit.slice(0, 7)}${tool.toolSourceModified ? ' (src modified!)' : ''}, node ${tool.node}`);

  for (const app of apps) {
    for (const asset of app.assets) {
      const key = cacheName(app, asset);
      const file = join(CACHE, key);
      const known = downloads[key];
      if (!known || !existsSync(file)) {
        console.error(`MISSING  ${key}: run download.mjs first`);
        process.exitCode = 1;
        continue;
      }
      if (sha256(file) !== known.sha256) {
        console.error(`CHANGED  ${key}: cache file does not match downloads.json; not scanning it`);
        process.exitCode = 1;
        continue;
      }
      const started = performance.now();
      const result = spawnSync(process.execPath, [BIN, file, '--json', '--fail-on', 'none'], {
        cwd: EMPTY_CWD, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GITHUB_ACTIONS: '' },
      });
      const ms = Math.round(performance.now() - started);
      const { outcome, report, detail } = classify(result);

      for (const ext of ['.json', '.stderr.txt']) rmSync(join(RESULTS, key + ext), { force: true });
      if (report) writeFileSync(join(RESULTS, `${key}.json`), `${JSON.stringify(report, null, 2)}\n`);
      if (result.stderr.trim()) writeFileSync(join(RESULTS, `${key}.stderr.txt`), result.stderr);

      const summary = report?.summary;
      runs.runs[key] = {
        app: app.id, tag: app.tag, asset, sha256: known.sha256, outcome, ...(detail ? { detail } : {}),
        exitCode: result.status, ms, ...(summary ? { summary } : {}),
        releaseLint: tool.version, commit: tool.commit, toolSourceModified: tool.toolSourceModified, node: tool.node, at: new Date().toISOString(),
      };
      const counts = summary ? `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info` : detail;
      console.log(`${outcome.padEnd(10)} ${key}  ${(ms / 1000).toFixed(1)}s  ${counts}`);
    }
  }
  runs.runs = Object.fromEntries(Object.entries(runs.runs).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(RUNS, `${JSON.stringify(runs, null, 2)}\n`);
}

main();
