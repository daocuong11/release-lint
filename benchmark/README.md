# Real-app benchmark

What release-lint finds on public release builds of open-source apps, and how often it is wrong.

The apps are public release artifacts of open-source projects, downloaded from their GitHub release pages. Any
finding that looks like a real live secret is disclosed privately to the maintainers before it is published.

## Reproduce

Node 20.19 or later. No dependencies beyond this repo's dev dependencies.

```sh
npm ci
node benchmark/download.mjs      # builds -> benchmark/cache/ (gitignored); SHA-256 and size -> downloads.json
node benchmark/run.mjs           # npm run build, then dist/bin.js --json on every build -> results/, runs.json
node benchmark/findings.mjs      # results/ -> findings.csv (keeps verdicts already written)
node benchmark/summarize.mjs     # findings.csv -> RESULTS.md (counts only the verdict column)
```

Add `--only mattermost,bluewallet` to `download.mjs` or `run.mjs` to limit them to some apps.
`download.mjs` stops if a published file no longer matches the SHA-256 recorded in `downloads.json`.

## Files

| File | What it holds |
|---|---|
| `apps.json` | Apps, exact release tags, asset names, group (A: active React Native/Expo, B: older React Native, C: not React Native), type, and notes on builds expected to trigger rules (testnet, unsigned, self-hosted) |
| `downloads.json` | URL, SHA-256 and size of every build |
| `results/` | Raw `--json` report per build, and stderr when there was any |
| `runs.json` | Outcome (scanned, unreadable, crash), exit code, time, release-lint version and commit per build |
| `findings.csv` | One row per app, build, rule and severity, with a count. `verdict` and `reason` were assigned with AI assistance (Claude), each checked against the app's source; corrections welcome |
| `RESULTS.md` | Tables per rule and per build, from `verdict` only |
| `NOTES.md` | Tool bugs and false-alarm patterns found, and which release fixed them |
| `baseline-<version>/` | A finished run kept as it was (results, runs.json, findings.csv, RESULTS.md, NOTES.md), for before and after comparisons. RESULTS.md compares raw counts with it |

## Verdicts

- `correct`: the problem really is in the shipped build.
- `intended`: read correctly, but the app does it on purpose (plain HTTP for self-hosted servers, a testnet host in a
  testnet build). The tool was right; the setting is a choice.
- `false-alarm`: the tool misread it, or it is not a real host (placeholder text, a library default).
- `cant-tell`: it depends on something we cannot see.

## Limits

- This measures how often a finding is wrong, not how many real problems release-lint misses.
- Group C apps have no JavaScript bundle, so only manifest and network rules apply to them.
- Evidence is kept masked exactly as release-lint prints it.
