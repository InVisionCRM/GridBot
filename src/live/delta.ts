/**
 * Status deltas for the live stream (v2). Shared by the server (diff) and the browser (apply). Plain JSON in, plain JSON
 * ops out. Schema: docs/stream-v2.md.
 *
 * Ops (path = keys and array indexes from the root of the status object):
 *   ['s', path, value]          set (replace) the value at path
 *   ['d', path]                 delete the key at path
 *   ['a', path, items, drop]    array: drop `drop` items from the front, then append `items` (rolling histories)
 *   ['p', path, items, keep]    array: keep the first `keep` items and put `items` in front (newest-first lists)
 */
export type Path = (string | number)[];
export type Op =
  | ['s', Path, unknown]
  | ['d', Path]
  | ['a', Path, unknown[], number]
  | ['p', Path, unknown[], number];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (x: unknown): x is Record<string, Json> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown) => JSON.stringify(x);

/** Ops that turn `a` into `b` (both plain JSON). */
export function diff(a: unknown, b: unknown, path: Path = [], ops: Op[] = []): Op[] {
  if (a === b) return ops;
  if (Array.isArray(a) && Array.isArray(b)) { diffArray(a, b, path, ops); return ops; }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(b)) {
      if (!(k in a)) ops.push(['s', [...path, k], b[k]]);
      else diff(a[k], b[k], [...path, k], ops);
    }
    for (const k of Object.keys(a)) if (!(k in b)) ops.push(['d', [...path, k]]);
    return ops;
  }
  ops.push(['s', path, b]);
  return ops;
}

function diffArray(a: unknown[], b: unknown[], path: Path, ops: Op[]) {
  if (!a.length || !b.length) { if (a.length !== b.length) ops.push(['s', path, b]); return; }
  const as = a.map(str), bs = b.map(str);
  // Same items, maybe a few changed in place (the bot lists): per index.
  if (a.length === b.length) {
    let same = 0;
    for (let i = 0; i < a.length; i++) if (as[i] === bs[i]) same++;
    if (same === a.length) return;
    // Rolling history at its cap (oldest dropped, newest added) is cheaper as 'a' or 'p' than per index.
    const shifted = rolled(as, bs) ?? prepended(as, bs);
    if (shifted && shifted[1] < a.length - same) { push(shifted[0], path, b, a, ops); return; }
    for (let i = 0; i < a.length; i++) if (as[i] !== bs[i]) diff(a[i], b[i], [...path, i], ops);
    return;
  }
  const s = rolled(as, bs) ?? prepended(as, bs);
  if (s && s[1] < b.length) { push(s[0], path, b, a, ops); return; }
  ops.push(['s', path, b]);
}

type Shift = { kind: 'a'; drop: number; add: number } | { kind: 'p'; keep: number; add: number };
/** b = a without its first `drop` items, plus `add` new ones at the end. [shift, items sent] */
function rolled(as: string[], bs: string[]): [Shift, number] | null {
  for (let drop = 0; drop < as.length; drop++) {
    if (as[drop] !== bs[0]) continue;
    const keep = as.length - drop;
    if (keep > bs.length) continue;
    let ok = true;
    for (let i = 0; i < keep; i++) if (as[drop + i] !== bs[i]) { ok = false; break; }
    if (ok) return [{ kind: 'a', drop, add: bs.length - keep }, bs.length - keep];
  }
  return null;
}
/** b = `add` new items in front of the first `keep` items of a. */
function prepended(as: string[], bs: string[]): [Shift, number] | null {
  for (let add = 1; add < bs.length; add++) {
    if (bs[add] !== as[0]) continue;
    const keep = bs.length - add;
    if (keep > as.length) continue;
    let ok = true;
    for (let i = 0; i < keep; i++) if (bs[add + i] !== as[i]) { ok = false; break; }
    if (ok) return [{ kind: 'p', keep, add }, add];
  }
  return null;
}
function push(s: Shift, path: Path, b: unknown[], _a: unknown[], ops: Op[]) {
  if (s.kind === 'a') ops.push(['a', path, b.slice(b.length - s.add), s.drop]);
  else ops.push(['p', path, b.slice(0, s.add), s.keep]);
}

/** Apply ops without mutating `root`: only the objects and arrays along each path are copied (React sees the change). */
export function apply<T>(root: T, ops: Op[]): T {
  let out: unknown = root;
  for (const op of ops) out = applyOne(out, op);
  return out as T;
}

function applyOne(node: unknown, op: Op, depth = 0): unknown {
  const path = op[1];
  if (depth === path.length) {
    switch (op[0]) {
      case 's': return op[2];
      case 'a': { const arr = node as unknown[]; return [...arr.slice(op[3]), ...op[2]]; }
      case 'p': { const arr = node as unknown[]; return [...op[2], ...arr.slice(0, op[3])]; }
      default: return node;
    }
  }
  const k = path[depth];
  if (Array.isArray(node)) {
    const copy = node.slice();
    copy[k as number] = applyOne(node[k as number], op, depth + 1);
    return copy;
  }
  const obj = (isObj(node) ? node : {}) as Record<string, unknown>;
  if (op[0] === 'd' && depth === path.length - 1) { const { [k as string]: _gone, ...rest } = obj; return rest; }
  return { ...obj, [k]: applyOne(obj[k as string], op, depth + 1) };
}
