// Turns the raw reports in benchmark/results/ into benchmark/findings.csv: one row per app, build file, rule and
// severity, with a count. (Severity is part of the key because host rules are an error in the Expo config and a
// warning in the bundle.) Re-running keeps suggested_verdict, reason and verdict already written for a row.
// Usage: node benchmark/findings.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FINDINGS_CSV, RESULTS, RUNS, parseCsv, readJson, toCsv } from './lib.mjs';

const MAX_LISTED = 20;
const rowKey = (r) => [r.app, r.file, r.rule, r.severity].join('\0');

const listDistinct = (values) => {
  const distinct = [...new Set(values)];
  const shown = distinct.slice(0, MAX_LISTED).join(' ; ');
  return distinct.length > MAX_LISTED ? `${shown} ; (+${distinct.length - MAX_LISTED} more)` : shown;
};

function main() {
  const runs = readJson(RUNS, { runs: {} }).runs;
  const previous = new Map((existsSync(FINDINGS_CSV) ? parseCsv(readFileSync(FINDINGS_CSV, 'utf8')) : []).map((r) => [rowKey(r), r]));
  const groups = new Map();

  for (const [key, run] of Object.entries(runs)) {
    if (run.outcome !== 'scanned') continue; // unreadable and crash are outcomes, reported in RESULTS.md, not findings
    const report = JSON.parse(readFileSync(join(RESULTS, `${key}.json`), 'utf8'));
    for (const f of report.findings) {
      const base = { app: run.app, tag: run.tag, file: run.asset, rule: f.ruleId, severity: f.severity };
      const k = rowKey(base);
      const group = groups.get(k) ?? { ...base, evidence: [], location: [] };
      group.evidence.push(f.evidence);
      group.location.push(f.location);
      groups.set(k, group);
    }
  }

  const rows = [...groups.values()].map((g) => {
    const old = previous.get(rowKey(g));
    return {
      ...g,
      count: g.evidence.length,
      evidence: listDistinct(g.evidence),
      location: listDistinct(g.location),
      suggested_verdict: old?.suggested_verdict ?? '',
      reason: old?.reason ?? '',
      verdict: old?.verdict ?? '',
    };
  });
  rows.sort((a, b) => a.app.localeCompare(b.app) || a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.severity.localeCompare(b.severity));

  const dropped = [...previous.entries()].filter(([k]) => !groups.has(k)).map(([, r]) => r);
  const reviewed = dropped.filter((r) => r.verdict || r.suggested_verdict || r.reason);
  if (reviewed.length > 0) {
    // A run of only some apps (--only) must never wipe verdicts written for the others.
    throw new Error(`refusing to drop ${reviewed.length} reviewed row(s) that no longer match a report, e.g. ${reviewed[0].app} ${reviewed[0].rule}`);
  }
  writeFileSync(FINDINGS_CSV, toCsv(rows));
  console.log(`${rows.length} rows (${rows.reduce((n, r) => n + r.count, 0)} findings) -> benchmark/findings.csv`);
}

main();
