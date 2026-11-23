// Extra tests for mend (main.ts), probing SPEC.md sentences the practice set does not show.
// Run: node tests/run-tests.mjs  — prints each failure and a summary; exit 1 when any fail.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

function runCheck(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const [p, text] of Object.entries(c.files ?? {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...(c.argv ?? [])], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
    const files = {};
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    return { exit: r.status, stdout: r.stdout ?? '', files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// expect.files: the full tree afterwards (patch files included, since mend never deletes its input unless told to).
const T = [];
const t = (name, c) => T.push([name, c]);

// --- CLI (section 1, 2) ---
t('usage: unknown option', { argv: ['--bogus'], files: {}, expect: { exit: 2, stdout: 'error: usage\n', files: {} } });
t('usage: --format twice', { argv: ['--format=json', '--format=json'], files: {}, expect: { exit: 2, stdout: 'error: usage\n', files: {} } });
t('usage: --check twice', { argv: ['--check', '--check'], files: {}, expect: { exit: 2, stdout: 'error: usage\n', files: {} } });
t('usage: bad format value', { argv: ['--format=diff'], files: {}, expect: { exit: 2, stdout: 'error: usage\n', files: {} } });
t('usage: two positionals', { argv: ['a.patch', 'b.patch'], files: {}, expect: { exit: 2, stdout: 'error: usage\n', files: {} } });
t('no-patch: missing file', { argv: ['nope.patch'], files: {}, expect: { exit: 2, stdout: 'error: no-patch\n', files: {} } });
t('format: undetectable stdin', { argv: [], stdin: 'just some prose\n', files: {}, expect: { exit: 2, stdout: 'error: format\n', files: {} } });
t('format: empty patch, forced unified', { argv: ['--format=unified', 'p'], files: { p: '' }, expect: { exit: 2, stdout: 'error: parse 1\n', files: { p: '' } } });
t('-- ends options: dash file is positional', {
  argv: ['--', '-x'],
  files: { '-x': '[{"command":"create","path":"a.txt","file_text":"hi\\n"}]' },
  expect: { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { '-x': '[{"command":"create","path":"a.txt","file_text":"hi\\n"}]', 'a.txt': 'hi\n' } },
});
t('options after patch are options', {
  argv: ['p', '--check'],
  files: { p: '[{"command":"create","path":"a.txt","file_text":"hi\\n"}]' },
  expect: { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { p: '[{"command":"create","path":"a.txt","file_text":"hi\\n"}]' } },
});

// --- atomicity & reporting (sections 2, 10) ---
t('exit 1: all failures in patch order, nothing written', {
  argv: ['p'],
  files: {
    p: '[{"command":"str_replace","path":"gone.txt","old_str":"x","new_str":"y"},{"command":"create","path":"new.txt","file_text":"n\\n"},{"command":"str_replace","path":"gone2.txt","old_str":"x","new_str":"y"}]',
  },
  expect: { exit: 1, stdout: 'error: missing gone.txt\nerror: missing gone2.txt\nfailed: 2 of 3 edits\n', files: { p: '[{"command":"str_replace","path":"gone.txt","old_str":"x","new_str":"y"},{"command":"create","path":"new.txt","file_text":"n\\n"},{"command":"str_replace","path":"gone2.txt","old_str":"x","new_str":"y"}]' } },
});
t('unsafe: dotdot in json', {
  argv: ['p'],
  files: { p: '[{"command":"create","path":"../evil.txt","file_text":"x"}]' },
  expect: { exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', files: { p: '[{"command":"create","path":"../evil.txt","file_text":"x"}]' } },
});
t('unsafe: backslash path in unified header', {
  argv: ['p'],
  files: { p: '--- a\\b.txt\n+++ a\\b.txt\n@@ -1 +1 @@\n-x\n+y\n', 'a\\b.txt': 'x\n' },
  expect: { exit: 1, stdout: 'error: unsafe a\\b.txt\nfailed: 1 of 1 edits\n', files: { p: '--- a\\b.txt\n+++ a\\b.txt\n@@ -1 +1 @@\n-x\n+y\n', 'a\\b.txt': 'x\n' } },
});
t('noop: replacement identical to original is not listed', {
  argv: ['p'],
  files: { p: '--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-same\n+same\n', 'f.txt': 'same\n' },
  expect: { exit: 0, stdout: 'ok: 0 files\n', files: { p: '--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-same\n+same\n', 'f.txt': 'same\n' } },
});
t('output sorted in byte order of paths', {
  argv: ['p'],
  files: { p: '[{"command":"create","path":"b.txt","file_text":"1"},{"command":"create","path":"A.txt","file_text":"2"},{"command":"create","path":"a/x.txt","file_text":"3"}]' },
  expect: {
    exit: 0,
    stdout: 'A A.txt\nA a/x.txt\nA b.txt\nok: 3 files\n',
    files: { p: '[{"command":"create","path":"b.txt","file_text":"1"},{"command":"create","path":"A.txt","file_text":"2"},{"command":"create","path":"a/x.txt","file_text":"3"}]', 'A.txt': '2', 'a/x.txt': '3', 'b.txt': '1' },
  },
});

// --- unified (section 6) ---
t('unified: malformed diff --git line', {
  argv: ['p'],
  files: { p: 'diff --git x y\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n', f: 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', files: { p: 'diff --git x y\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n', f: 'a\n' } },
});
t('unified: hunk before any section (forced format)', {
  argv: ['--format=unified', 'p'],
  files: { p: '@@ -1 +1 @@\n-a\n+b\n', f: 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', files: { p: '@@ -1 +1 @@\n-a\n+b\n', f: 'a\n' } },
});
t('auto: a bare hunk detects no format', {
  argv: ['p'],
  files: { p: '@@ -1 +1 @@\n-a\n+b\n', f: 'a\n' },
  expect: { exit: 2, stdout: 'error: format\n', files: { p: '@@ -1 +1 @@\n-a\n+b\n', f: 'a\n' } },
});
t('unified: --- not followed by +++ inside a header', {
  argv: ['p'],
  files: { p: 'diff --git a/f b/f\n--- a/f\ngarbage\n', f: 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 3\n', files: { p: 'diff --git a/f b/f\n--- a/f\ngarbage\n', f: 'a\n' } },
});
t('unified: rename from/to without ---/+++ pair gives R line', {
  argv: ['p'],
  files: { p: 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n', 'old.txt': 'data\n' },
  expect: { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', files: { p: 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n', 'new.txt': 'data\n' } },
});
t('unified: move with hunks', {
  argv: ['p'],
  files: { p: 'diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-a\n+A\n', 'old.txt': 'a\n' },
  expect: { exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', files: { p: 'diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-a\n+A\n', 'new.txt': 'A\n' } },
});
t('unified: creation with \\ after last + has no final break', {
  argv: ['p'],
  files: { p: '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+only\n\\ No newline at end of file\n' },
  expect: { exit: 0, stdout: 'A n.txt\nok: 1 file\n', files: { p: '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+only\n\\ No newline at end of file\n', 'n.txt': 'only' } },
});
t('unified: hunk at EOF, \\ after - line only: result keeps a final break', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n keep\n-last\n\\ No newline at end of file\n', f: 'keep\nlast' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n keep\n-last\n\\ No newline at end of file\n', f: 'keep\n' } },
});
t('unified: hunk not at EOF leaves final break as it was', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'a\nb' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'A\nb' } },
});
t('unified: pure insertion hunk (empty O) after A lines', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1,0 +2 @@\n+mid\n', f: 'a\nb\n' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1,0 +2 @@\n+mid\n', f: 'a\nmid\nb\n' } },
});
t('unified: insertion at end of file without \\ gains a final break', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1,0 +2 @@\n+tail\n', f: 'a' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1,0 +2 @@\n+tail\n', f: 'a\ntail\n' } },
});
t('unified: tab-separated timestamps on ---/+++ lines', {
  argv: ['p'],
  files: { p: '--- a/f\t2026-01-01\n+++ b/f\t2026-01-02\n@@ -1 +1 @@\n-a\n+A\n', f: 'a\n' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\t2026-01-01\n+++ b/f\t2026-01-02\n@@ -1 +1 @@\n-a\n+A\n', f: 'A\n' } },
});
t('unified: tier 1 trailing-whitespace drift', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'a   \n' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'A\n' } },
});
t('unified: tier 2 re-indent with unindented old block', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-x\n-y\n+z\n+w\n', f: '    x\n    y\n' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-x\n-y\n+z\n+w\n', f: '    z\n    w\n' } },
});
t('unified: nearest occurrence, tie takes the earlier', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -2 +2 @@\n-x\n+X\n', f: 'x\na\nx\n' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -2 +2 @@\n-x\n+X\n', f: 'X\na\nx\n' } },
});
t('unified: deletion section ignores its hunks', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n', f: 'x\n' },
  expect: { exit: 0, stdout: 'D f\nok: 1 file\n', files: { p: '--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n' } },
});
t('unified: change to a missing file', {
  argv: ['p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n' },
  expect: { exit: 1, stdout: 'error: missing f\nfailed: 1 of 1 edits\n', files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n' } },
});
t('unified: creation over an existing file', {
  argv: ['p'],
  files: { p: '--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+x\n', f: 'old\n' },
  expect: { exit: 1, stdout: 'error: exists f\nfailed: 1 of 1 edits\n', files: { p: '--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+x\n', f: 'old\n' } },
});

// --- SEARCH/REPLACE (section 7) ---
t('sr: second block without a path line takes the previous path', {
  argv: ['p'],
  files: {
    p: 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
    'f.txt': 'a\nb\n',
  },
  expect: {
    exit: 0,
    stdout: 'M f.txt\nok: 1 file\n',
    files: { p: 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n', 'f.txt': 'A\nB\n' },
  },
});
t('sr: first block with no path line is a parse error at the SEARCH line', {
  argv: ['p'],
  files: { p: '<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 1\n', files: { p: '<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' } },
});
t('sr: no ======= after SEARCH is a parse error at the SEARCH line', {
  argv: ['p'],
  files: { p: 'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 2\n', files: { p: 'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' } },
});
t('sr: markers may carry trailing whitespace', {
  argv: ['p'],
  files: { p: 'f.txt\n<<<<<<< SEARCH  \na\n======= \nA\n>>>>>>> REPLACE\t\n', 'f.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { p: 'f.txt\n<<<<<<< SEARCH  \na\n======= \nA\n>>>>>>> REPLACE\t\n', 'f.txt': 'A\n' } },
});
t('sr: fenced block, fence lines are not the path', {
  argv: ['p'],
  files: { p: 'f.txt\n```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n', 'f.txt': 'a\n' },
  expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { p: 'f.txt\n```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n', 'f.txt': 'A\n' } },
});
t('sr: create over existing file fails exists', {
  argv: ['p'],
  files: { p: 'f.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n', 'f.txt': 'old\n' },
  expect: { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', files: { p: 'f.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n', 'f.txt': 'old\n' } },
});
t('sr: tier 2 re-indent', {
  argv: ['p'],
  files: { p: 'f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n', 'f.txt': '  x\n' },
  expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { p: 'f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n', 'f.txt': '  y\n' } },
});

// --- V4A (section 8) ---
t('v4a: missing End Patch is parse at line count + 1', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Add File: n.txt\n+x\n' },
  expect: { exit: 2, stdout: 'error: parse 4\n', files: { p: '*** Begin Patch\n*** Add File: n.txt\n+x\n' } },
});
t('v4a: first non-blank line is not Begin Patch (forced format)', {
  argv: ['--format=v4a', 'p'],
  files: { p: '\n\nhello\n*** Begin Patch\n*** End Patch\n' },
  expect: { exit: 2, stdout: 'error: parse 3\n', files: { p: '\n\nhello\n*** Begin Patch\n*** End Patch\n' } },
});
t('v4a: update with no chunk and no move is a parse error at its line', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n*** End Patch\n', 'f.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 2\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n*** End Patch\n', 'f.txt': 'a\n' } },
});
t('v4a: add file with a non-+ line is a parse error', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Add File: n.txt\nx\n*** End Patch\n' },
  expect: { exit: 2, stdout: 'error: parse 3\n', files: { p: '*** Begin Patch\n*** Add File: n.txt\nx\n*** End Patch\n' } },
});
t('v4a: delete file section with lines is a parse error', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Delete File: f.txt\n+x\n*** End Patch\n', 'f.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 3\n', files: { p: '*** Begin Patch\n*** Delete File: f.txt\n+x\n*** End Patch\n', 'f.txt': 'a\n' } },
});
t('v4a: eof chunk whose block does not end at the last line is no-match', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@\n-a\n+A\n*** End of File\n*** End Patch\n', 'f.txt': 'a\nb\n' },
  expect: { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@\n-a\n+A\n*** End of File\n*** End Patch\n', 'f.txt': 'a\nb\n' } },
});
t('v4a: eof chunk anchored to the end', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@\n-b\n+B\n*** End of File\n*** End Patch\n', 'f.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@\n-b\n+B\n*** End of File\n*** End Patch\n', 'f.txt': 'a\nB\n' } },
});
t('v4a: pure move (no chunks)', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n*** Move to: g.txt\n*** End Patch\n', 'f.txt': 'a\n' },
  expect: { exit: 0, stdout: 'R f.txt -> g.txt\nok: 1 file\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n*** Move to: g.txt\n*** End Patch\n', 'g.txt': 'a\n' } },
});
t('v4a: move to an existing path fails exists', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n*** Move to: g.txt\n*** End Patch\n', 'f.txt': 'a\n', 'g.txt': 'b\n' },
  expect: { exit: 1, stdout: 'error: exists g.txt\nfailed: 1 of 1 edits\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n*** Move to: g.txt\n*** End Patch\n', 'f.txt': 'a\n', 'g.txt': 'b\n' } },
});
t('v4a: anchor not found is no-match', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@ class Nope\n-a\n+A\n*** End Patch\n', 'f.txt': 'a\n' },
  expect: { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@ class Nope\n-a\n+A\n*** End Patch\n', 'f.txt': 'a\n' } },
});
t('v4a: empty chunk inserts at the cursor', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@ a\n+inserted\n*** End Patch\n', 'f.txt': 'a\nb\n' },
  expect: { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { p: '*** Begin Patch\n*** Update File: f.txt\n@@ a\n+inserted\n*** End Patch\n', 'f.txt': 'a\ninserted\nb\n' } },
});
t('v4a: add file ends with a line break, blank lines inside kept', {
  argv: ['p'],
  files: { p: '*** Begin Patch\n*** Add File: n.txt\n+one\n\n+three\n*** End Patch\n' },
  expect: { exit: 0, stdout: 'A n.txt\nok: 1 file\n', files: { p: '*** Begin Patch\n*** Add File: n.txt\n+one\n\n+three\n*** End Patch\n', 'n.txt': 'one\n\nthree\n' } },
});

// --- JSON (section 9) ---
t('json: insert_line past the end is no-match', {
  argv: ['p'],
  files: { p: '{"command":"insert","path":"f.txt","insert_line":5,"new_str":"x"}', 'f.txt': 'a\nb\n' },
  expect: { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { p: '{"command":"insert","path":"f.txt","insert_line":5,"new_str":"x"}', 'f.txt': 'a\nb\n' } },
});
t('json: bad object in array faults at the array line', {
  argv: ['p'],
  files: { p: '\n[{"command":"fly","path":"f.txt"}]', 'f.txt': 'a\n' },
  expect: { exit: 2, stdout: 'error: parse 2\n', files: { p: '\n[{"command":"fly","path":"f.txt"}]', 'f.txt': 'a\n' } },
});
t('json: str_replace overlapping occurrences are ambiguous', {
  argv: ['p'],
  files: { p: '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}', 'f.txt': 'aaa\n' },
  expect: { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', files: { p: '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}', 'f.txt': 'aaa\n' } },
});

// --- --strict / --check (sections 1, 5) ---
t('strict: whitespace drift no longer matches', {
  argv: ['--strict', 'p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'a   \n' },
  expect: { exit: 1, stdout: 'error: no-match f\nfailed: 1 of 1 edits\n', files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'a   \n' } },
});
t('check: reports but writes nothing', {
  argv: ['--check', 'p'],
  files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'a\n' },
  expect: { exit: 0, stdout: 'M f\nok: 1 file\n', files: { p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n', f: 'a\n' } },
});

let failed = 0;
for (const [name, c] of T) {
  const got = runCheck(c);
  const want = c.expect;
  const why = [];
  if (got.exit !== want.exit) why.push(`exit ${got.exit}, expected ${want.exit}`);
  if (got.stdout !== want.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(want.stdout)}`);
  for (const p of new Set([...Object.keys(want.files), ...Object.keys(got.files)])) {
    if (want.files[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== want.files[p]) why.push(`${p} differs: expected ${JSON.stringify(want.files[p])}, got ${JSON.stringify(got.files[p])}`);
  }
  if (why.length > 0) {
    failed += 1;
    process.stdout.write(`FAIL ${name}\n  ${why.join('\n  ')}\n`);
  }
}
process.stdout.write(`${T.length - failed} of ${T.length} extra tests passed\n`);
process.exit(failed === 0 ? 0 : 1);
