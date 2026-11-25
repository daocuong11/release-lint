// Writes benchmark/RESULTS.md from findings.csv, runs.json and apps.json.
// Only the `verdict` column is counted. `suggested_verdict` is never read here.
// Secret findings of apps listed as `exclude-secrets: <app-id>` in the gitignored PRIVATE-disclosures.md are left
// out until the maintainer has been contacted.
// Usage: node benchmark/summarize.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCH, FINDINGS_CSV, PRIVATE, RUNS, VERDICTS, loadApps, parseCsv, readJson } from './lib.mjs';

const LABEL = { correct: 'Correct', intended: 'Intended', 'false-alarm': 'False alarm', 'cant-tell': "Can't tell", '': 'Not reviewed' };

function excludedApps() {
  if (!existsSync(PRIVATE)) return new Set();
  return new Set([...readFileSync(PRIVATE, 'utf8').matchAll(/^\s*-?\s*exclude-secrets:\s*(\S+)/gm)].map((m) => m[1]));
}

function tally(rows) {
  const t = { rows: rows.length, findings: 0, correct: 0, intended: 0, 'false-alarm': 0, 'cant-tell': 0, '': 0 };
  for (const r of rows) {
    t.findings += Number(r.count) || 0;
    t[r.verdict] += 1;
  }
  return t;
}

/** Number columns (counts, times) are right-aligned; text columns are left-aligned. */
const isNumeric = (rows, i) => rows.length > 0 && rows.every((r) => /^\d+(\.\d+)?s?$/.test(String(r[i])));
/**
 * Raw counts per release-lint version, from benchmark/baseline-<version>/ folders plus the current run. Verdict-free on
 * purpose: these are what the tool printed, not judgments, so they can be compared before anyone reviews a row.
 */
function versionCounts(label, runs, rows) {
  const list = Object.values(runs);
  const findings = (severity) => rows.filter((r) => r.severity === severity).reduce((n, r) => n + (Number(r.count) || 0), 0);
  return [label, list.filter((r) => r.outcome === 'scanned').length, list.filter((r) => r.outcome !== 'scanned').length, rows.length, findings('error'), findings('warning'), findings('info')];
}

function comparison(currentRuns, currentRows) {
  const baselines = readdirSync(BENCH).filter((d) => /^baseline-\d+\.\d+\.\d+$/.test(d)).sort();
  if (baselines.length === 0) return '';
  const lines = baselines.map((dir) => {
    const runs = readJson(join(BENCH, dir, 'runs.json'), { runs: {} }).runs;
    return versionCounts(dir.replace('baseline-', ''), runs, parseCsv(readFileSync(join(BENCH, dir, 'findings.csv'), 'utf8')));
  });
  const current = Object.values(currentRuns)[0]?.releaseLint ?? 'current';
  return `## Compared with earlier versions

Raw counts on the same ${Object.keys(currentRuns).length} builds (same SHA-256), before any review. Errors and warnings are individual findings.

${table(['release-lint', 'Scanned', 'Unreadable or crashed', 'Finding rows', 'Errors', 'Warnings', 'Info'], [...lines, versionCounts(`${current} (this run)`, currentRuns, currentRows)])}

`;
}

const table = (head, rows) =>
  [`| ${head.join(' | ')} |`, `|${head.map((_, i) => (isNumeric(rows, i) ? '--:' : '---')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const pct = (part, whole) => (whole === 0 ? 'n/a' : `${Math.round((100 * part) / whole)}%`);
const md = (s) => String(s).replace(/\|/g, '\\|');

function main() {
  const apps = loadApps();
  const runs = readJson(RUNS, { runs: {} }).runs;
  const excluded = excludedApps();
  const all = parseCsv(readFileSync(FINDINGS_CSV, 'utf8'));

  const bad = all.filter((r) => r.verdict !== '' && !VERDICTS.includes(r.verdict));
  if (bad.length > 0) throw new Error(`findings.csv: unknown verdict "${bad[0].verdict}" (use ${VERDICTS.join(', ')} or leave empty)`);

  const rows = all.filter((r) => !(excluded.has(r.app) && r.rule.startsWith('secret/')));
  const withheld = all.length - rows.length;
  const runList = Object.values(runs);
  const versions = [...new Set(runList.map((r) => `${r.releaseLint} (${r.commit.slice(0, 7)}${r.toolSourceModified ? ', modified' : ''})`))];
  const outcomes = Object.fromEntries(['scanned', 'unreadable', 'crash'].map((o) => [o, runList.filter((r) => r.outcome === o).length]));
  const total = tally(rows);
  // Rows with a clear answer: the tool was right (a real problem, or a deliberate setting) or wrong.
  const judged = total.correct + total.intended + total['false-alarm'];

  const byRule = [...new Set(rows.map((r) => r.rule))].sort().map((rule) => {
    const t = tally(rows.filter((r) => r.rule === rule));
    return [`\`${rule}\``, t.rows, t.findings, t.correct, t.intended, t['false-alarm'], t['cant-tell'], t['']];
  });

  const byBuild = Object.entries(runs).map(([key, run]) => {
    const app = apps.find((a) => a.id === run.app);
    const t = tally(rows.filter((r) => r.app === run.app && r.file === run.asset));
    const outcome = run.outcome === 'scanned' ? 'scanned' : `**${run.outcome}**: ${md(run.detail ?? '')}`;
    return [md(run.app), app?.group ?? '', app?.type ?? '', `\`${md(run.asset)}\``, outcome, `${(run.ms / 1000).toFixed(1)}s`, t.rows, t.correct, t.intended, t['false-alarm'], t['cant-tell'], t['']];
  });

  const text = `# release-lint benchmark results

Generated by \`node benchmark/summarize.mjs\`. How to reproduce: [README.md](README.md).

- release-lint: ${versions.join(', ') || 'n/a'}
- Builds: ${runList.length} (${outcomes.scanned} scanned, ${outcomes.unreadable} unreadable, ${outcomes.crash} crashed)
- Finding rows: ${total.rows} (${total.findings} individual findings, grouped per app, build, rule and severity)
- Verdicts given: ${total.rows - total['']} of ${total.rows} rows
- Real problems found (correct): **${total.correct}** rows
- Read correctly (correct or intended), of the rows with a clear answer: **${pct(total.correct + total.intended, judged)}** (${total.correct + total.intended} of ${judged}); false alarms: ${total['false-alarm']}
${withheld > 0 ? `- ${withheld} secret finding row(s) are withheld until the maintainers have been contacted privately.\n` : ''}
Verdicts were assigned with AI assistance (Claude): each finding was checked against the app's published source
code, and the reason is in findings.csv, where anyone can dispute it. The verdicts are: **correct** (a real problem in the shipped build), **intended** (read
correctly, but the app does it on purpose, such as plain HTTP for self-hosted servers or a testnet host in a testnet
build), **false alarm** (the tool misread it, or it is not a real host, such as placeholder text) or **can't tell**
(depends on something we cannot see).

What this does not measure: problems release-lint misses. It shows how often a finding is wrong, not how many
real problems go unreported.

${comparison(runs, all)}## Per rule

${table(['Rule', 'Rows', 'Findings', 'Correct', 'Intended', 'False alarm', "Can't tell", 'Not reviewed'], byRule)}

## Per build

${table(['App', 'Group', 'Type', 'Build', 'Outcome', 'Time', 'Rows', 'Correct', 'Intended', 'False alarm', "Can't tell", 'Not reviewed'], byBuild)}
`;
  writeFileSync(join(BENCH, 'RESULTS.md'), text);
  console.log(`RESULTS.md: ${total.rows} rows, ${total.rows - total['']} reviewed${withheld ? `, ${withheld} withheld` : ''}`);
}

main();
