import { diffArrays } from 'diff';
import { createHash } from 'crypto';

export interface Hunk {
  index: number;
  /** 0-based line index in the original where the removed lines start. */
  origStart: number;
  removed: string[];
  /** 0-based line index in the proposed text where the added lines start. */
  newStart: number;
  added: string[];
}

export type HunkState = 'pending' | 'accepted' | 'rejected';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Split into lines keeping line endings, so join('') is lossless. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  const parts = diffArrays(a, b);
  const hunks: Hunk[] = [];
  let oi = 0;
  let ni = 0;
  let cur: Hunk | undefined;
  for (const p of parts) {
    const vals = p.value as string[];
    if (!p.added && !p.removed) {
      if (cur) { hunks.push(cur); cur = undefined; }
      oi += vals.length;
      ni += vals.length;
      continue;
    }
    if (!cur) cur = { index: hunks.length, origStart: oi, removed: [], newStart: ni, added: [] };
    if (p.removed) { cur.removed.push(...vals); oi += vals.length; }
    else { cur.added.push(...vals); ni += vals.length; }
  }
  if (cur) hunks.push(cur);
  hunks.forEach((h, i) => (h.index = i));
  return hunks;
}

/** original + only the accepted hunks. */
export function applyHunks(original: string, hunks: Hunk[], accepted: boolean[]): string {
  const a = splitLines(original);
  const out: string[] = [];
  let oi = 0;
  for (const h of hunks) {
    while (oi < h.origStart) out.push(a[oi++]);
    if (accepted[h.index]) {
      out.push(...h.added);
    } else {
      out.push(...h.removed);
    }
    oi += h.removed.length;
  }
  while (oi < a.length) out.push(a[oi++]);
  // Fix a missing newline at a seam (e.g. accepted hunk ending without \n followed by more lines).
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].endsWith('\n')) out[i] = out[i] + '\n';
  }
  return out.join('');
}

export function hunkSummary(h: Hunk): string {
  return `-${h.removed.length} +${h.added.length} @ line ${h.origStart + 1}`;
}
