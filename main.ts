// main.ts is mend, the CLI SPEC.md specifies. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers (section 5), and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;
interface Move {
  old: string;
  new: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and line matching (section 5).

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFileText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const lines = text.split(br);
  if (fin) lines.pop();
  return { lines, br, final: fin };
}

function serializeFile(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];
const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Every position at or after `from` where O's lines match the file's lines at `tier`; may overlap. */
function occurrences(lines: string[], o: string[], from: number, tier: number): number[] {
  const res: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when it occurs at none. */
function firstTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const ps = occurrences(lines, o, from, t);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

type EntryKind = 'ctx' | 'old' | 'new' | 'note';
interface Entry {
  kind: EntryKind;
  text: string;
  emptyLine?: boolean;
}

/**
 * The lines a match is replaced by: body entries in order, `old` entries dropped, context entries written
 * as the file's own matched line, `new` entries as written — at tier 2 re-indented (section 5).
 */
function buildNew(lines: string[], pos: number, entries: Entry[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadST(lines[pos] ?? '');
    const firstOld = entries.find((e) => e.kind === 'ctx' || e.kind === 'old');
    p = leadST(firstOld?.text ?? '');
  }
  const out: string[] = [];
  let oi = 0;
  for (const e of entries) {
    if (e.kind === 'old') {
      oi += 1;
    } else if (e.kind === 'ctx') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (e.kind === 'new') {
      let t = e.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** True when a `\` note immediately follows the body's last context or `+` entry. */
function backslashAfterLastNew(entries: Entry[]): boolean {
  let last = -1;
  entries.forEach((e, i) => {
    if (e.kind === 'ctx' || e.kind === 'new') last = i;
  });
  return last >= 0 && entries[last + 1]?.kind === 'note';
}

// ---------------------------------------------------------------------------
// JSON edits (section 9).

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6).

interface Hunk {
  a: number;
  entries: Entry[];
}
interface Section {
  gitX?: string;
  gitY?: string;
  hdrOld?: string;
  hdrNew?: string;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function cleanDiffPath(s: string): string {
  let p = s.split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const isGit = (l: string): boolean => l.startsWith('diff --git ') || l === 'diff --git';
  const gitPaths = (l: string, idx: number): [string, string] => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    return [m[1]!, m[2]!];
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (isGit(l)) {
      const [x, y] = gitPaths(l, i);
      cur = { gitX: x, gitY: y, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!(cur !== null && inHeader)) {
        cur = { newFile: false, delFile: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      cur.hdrOld = cleanDiffPath(l.slice(4));
      cur.hdrNew = cleanDiffPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), entries: [] };
      cur.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (isGit(b) || b.startsWith('@@')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '') hunk.entries.push({ kind: 'ctx', text: '', emptyLine: true });
        else if (c === ' ') hunk.entries.push({ kind: 'ctx', text: b.slice(1) });
        else if (c === '-') hunk.entries.push({ kind: 'old', text: b.slice(1) });
        else if (c === '+') hunk.entries.push({ kind: 'new', text: b.slice(1) });
        else if (c === '\\') hunk.entries.push({ kind: 'note', text: b.slice(1) });
        else break;
        i += 1;
      }
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1]!;
        if (last.kind === 'ctx' && last.emptyLine === true) hunk.entries.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renFrom = l.slice(12).replace(/^ +| +$/g, '');
      else if (l.startsWith('rename to ')) cur.renTo = l.slice(10).replace(/^ +| +$/g, '');
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      else if (l.startsWith('+++ ')) cur.hdrNew = cleanDiffPath(l.slice(4));
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** One hunk applied to `f`; returns (N's length − O's length). Throws Fail on no-match. */
function applyHunk(f: FileText, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const entries = hunk.entries;
  const o = entries.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
  const noBreak = backslashAfterLastNew(entries);
  if (o.length === 0) {
    const news = entries.filter((e) => e.kind === 'new').map((e) => e.text);
    const pos = Math.max(0, Math.min(hunk.a + d, f.lines.length));
    const atEnd = pos === f.lines.length;
    f.lines.splice(pos, 0, ...news);
    if (atEnd) f.final = !noBreak;
    return news.length;
  }
  const found = firstTier(f.lines, o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const repl = buildNew(f.lines, best, entries, found.tier);
  const runsToEnd = best + o.length === f.lines.length;
  f.lines.splice(best, o.length, ...repl);
  if (runsToEnd) f.final = !noBreak;
  return repl.length - o.length;
}

function sectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    const oldRaw = sec.hdrOld !== undefined ? sec.hdrOld : sec.renFrom !== undefined ? sec.renFrom : sec.gitX!;
    const newRaw = sec.hdrNew !== undefined ? sec.hdrNew : sec.renTo !== undefined ? sec.renTo : sec.gitY!;
    const creation = oldRaw === '/dev/null' || sec.newFile;
    const deletion = newRaw === '/dev/null' || sec.delFile;
    for (const p of [oldRaw, newRaw]) {
      if (p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (creation) {
      const p = newRaw;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const all = sec.hunks.flatMap((h) => h.entries);
      const plus = all.filter((e) => e.kind === 'new').map((e) => e.text);
      let lastNew = -1;
      all.forEach((e, idx) => {
        if (e.kind === 'new') lastNew = idx;
      });
      const noBreak = lastNew >= 0 && all[lastNew + 1]?.kind === 'note';
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (tree.get(oldRaw) === null) throw new Fail('missing', oldRaw);
      tree.now.set(oldRaw, null);
      return;
    }
    const content = tree.get(oldRaw);
    if (content === null) throw new Fail('missing', oldRaw);
    const isMove = newRaw !== oldRaw;
    if (isMove && tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
    const f = parseFileText(content);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(f, h, d, strict, oldRaw);
    const out = serializeFile(f);
    if (isMove) {
      tree.now.set(oldRaw, null);
      tree.now.set(newRaw, out);
      moves.push({ old: oldRaw, new: newRaw });
    } else {
      tree.now.set(oldRaw, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections = parseSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict, moves));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7).

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const f = parseFileText(content);
    const found = firstTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const entries: Entry[] = [
      ...oldLines.map((t): Entry => ({ kind: 'old', text: t })),
      ...newLines.map((t): Entry => ({ kind: 'new', text: t })),
    ];
    const repl = buildNew(f.lines, pos, entries, found.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | undefined;
    for (let j = at - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${at + 1}`);
    let j = at + 1;
    const oldLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${at + 1}`);
    j += 1;
    const newLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${at + 1}`);
    prevEnd = j;
    prevPath = path;
    i = j + 1;
    edits.push(srEdit(path, oldLines, newLines, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8).

interface Chunk {
  anchor: string | null;
  entries: Entry[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: Chunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFileText(content);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const foundA = firstTier(f.lines, [ch.anchor], cursor, strict);
        if (foundA === null) throw new Fail('no-match', path);
        cursor = foundA.positions[0]! + 1;
      }
      const o = ch.entries.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
      if (o.length === 0) {
        const news = ch.entries.filter((e) => e.kind === 'new').map((e) => e.text);
        const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(pos, 0, ...news);
        cursor = pos + news.length;
        continue;
      }
      const found = firstTier(f.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let positions = found.positions;
      if (ch.eof) positions = positions.filter((p) => p + o.length === f.lines.length);
      if (positions.length === 0) throw new Fail('no-match', path);
      const pos = positions[0]!;
      const repl = buildNew(f.lines, pos, ch.entries, found.tier);
      f.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = serializeFile(f);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const firstNb = lines.findIndex((l) => !blank(l));
  if (firstNb < 0) throw new Exit2('error: parse 1');
  if (lines[firstNb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNb + 1}`);
  let lastNb = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastNb = k;
      break;
    }
  }
  if (lines[lastNb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secKind = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = firstNb + 1;
  while (i < lastNb) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = secKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).replace(/^ +| +$/g, '');
    const raw: { text: string; idx: number }[] = [];
    let j = i + 1;
    while (j < lastNb && secKind(lines[j]!) === null) {
      raw.push({ text: lines[j]!, idx: j });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    i = j;
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | undefined;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).replace(/^ +| +$/g, '');
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim() || null, entries: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, entries: [], eof: true };
            chunks.push(cur);
          } else cur.eof = true;
          continue;
        }
        const c = t[0];
        if (t === '' || c === ' ' || c === '-' || c === '+') {
          if (cur !== null && cur.eof) throw new Exit2(`error: parse ${r.idx + 1}`);
          if (cur === null) {
            cur = { anchor: null, entries: [], eof: false };
            chunks.push(cur);
          }
          if (t === '') cur.entries.push({ kind: 'ctx', text: '' });
          else if (c === ' ') cur.entries.push({ kind: 'ctx', text: t.slice(1) });
          else if (c === '-') cur.entries.push({ kind: 'old', text: t.slice(1) });
          else cur.entries.push({ kind: 'new', text: t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// The run (sections 1, 2 and 10).

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.now.get(p)! !== tree.original(p));
  const rMoves = moves.filter(
    (m) => changed.includes(m.old) && changed.includes(m.new) && tree.original(m.old) !== null && tree.now.get(m.old)! === null && tree.original(m.new) === null && tree.now.get(m.new)! !== null,
  );
  const used = new Set<string>();
  for (const m of rMoves) {
    used.add(m.old);
    used.add(m.new);
  }
  const rows: { key: string; line: string }[] = [];
  for (const m of rMoves) rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
