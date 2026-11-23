# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aygal01/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aygal01/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — in all four formats they write them in — to a tree of text files:

- **unified diffs**, including hunks whose line numbers are wrong (the hunk is placed at the occurrence nearest the stated line);
- **SEARCH/REPLACE blocks** (Aider-style `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`, with Add / Delete / Update / Move to and anchored or end-of-file chunks);
- **JSON tool calls** (an array of edit objects, or JSON Lines: `create`, `str_replace`, `insert`).

The format is detected automatically, or forced with `--format`. Lines an edit names are found at the first of three matching tiers — exact, then ignoring trailing whitespace, then ignoring leading and trailing whitespace (with re-indentation of the replacement) — or exactly only, with `--strict`. Edits apply in order, each one all-or-nothing: if any edit fails, mend prints one `error: <code> <path>` line per failed edit and writes nothing; if all succeed, it writes the tree and prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and an `ok:` summary. `--check` reports without writing. The full contract is [SPEC.md](SPEC.md).

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file's path; with no `PATCH` (or `-`) the patch is read from standard input. Node 22 and its standard library alone — nothing to install.

## Files

- `main.ts` — the CLI itself.
- `runner.ts` — the kit's trial runner (kept as the kit ships it): when `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.
- `check.ts` — runs `main.ts` against the kit's public practice set: `node check.ts <practice.json>`.
- `tests/run-tests.mjs` — extra tests probing SPEC.md sentences the practice set does not show: `node tests/run-tests.mjs`.
- `SPEC.md` — the specification mend is built to.

---

<sub>Entered on [make.fun](https://make.fun/?ref=28h0926y&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
