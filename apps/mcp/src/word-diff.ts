/**
 * Word-level text diff for tracked changes.
 *
 * Computes the minimal set of edits between two strings at word granularity
 * using LCS (longest common subsequence). Produces targeted edit operations
 * that create clean tracked changes in Word — only changed words are marked.
 */

export interface TextEdit {
  /** Offset within the original string where the change starts. */
  originalStart: number;
  /** Offset within the original string where the change ends. */
  originalEnd: number;
  /** Replacement text for the changed portion. */
  replacement: string;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Tokenize string into words preserving whitespace boundaries and char offsets. */
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+|\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/** Compute LCS table for two token arrays (by text equality). */
function lcsTable(a: Token[], b: Token[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1].text === b[j - 1].text) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/**
 * Compute the minimal set of text edits to transform `original` into `replacement`.
 *
 * Uses word-level LCS to find unchanged regions, then groups consecutive
 * changes into edit operations. Adjacent edits separated by short gaps
 * (whitespace/punctuation) are merged to reduce fragmentation.
 */
export function computeWordDiff(original: string, replacement: string): TextEdit[] {
  if (original === replacement) return [];

  const aTokens = tokenize(original);
  const bTokens = tokenize(replacement);

  if (aTokens.length === 0) return [{ originalStart: 0, originalEnd: 0, replacement }];
  if (bTokens.length === 0) return [{ originalStart: 0, originalEnd: original.length, replacement: '' }];

  const dp = lcsTable(aTokens, bTokens);

  // Backtrack to find aligned pairs
  type Action =
    | { type: 'keep'; ai: number; bi: number }
    | { type: 'delete'; ai: number }
    | { type: 'insert'; bi: number };

  const actions: Action[] = [];
  let i = aTokens.length;
  let j = bTokens.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aTokens[i - 1].text === bTokens[j - 1].text) {
      actions.push({ type: 'keep', ai: i - 1, bi: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      actions.push({ type: 'insert', bi: j - 1 });
      j--;
    } else {
      actions.push({ type: 'delete', ai: i - 1 });
      i--;
    }
  }
  actions.reverse();

  // Group consecutive non-keep actions into TextEdits
  const edits: TextEdit[] = [];
  let idx = 0;
  while (idx < actions.length) {
    if (actions[idx].type === 'keep') {
      idx++;
      continue;
    }

    let origStart = Infinity;
    let origEnd = -1;
    const insertParts: string[] = [];

    while (idx < actions.length && actions[idx].type !== 'keep') {
      const act = actions[idx];
      if (act.type === 'delete') {
        const tok = aTokens[act.ai];
        origStart = Math.min(origStart, tok.start);
        origEnd = Math.max(origEnd, tok.end);
      } else if (act.type === 'insert') {
        insertParts.push(bTokens[act.bi].text);
      }
      idx++;
    }

    // Pure insertion (no deletion)
    if (origStart === Infinity) {
      let insertAt = 0;
      for (let k = idx - 1; k >= 0; k--) {
        if (actions[k].type === 'keep') {
          insertAt = aTokens[(actions[k] as { ai: number }).ai].end;
          break;
        }
      }
      edits.push({ originalStart: insertAt, originalEnd: insertAt, replacement: insertParts.join('') });
    } else {
      edits.push({ originalStart: origStart, originalEnd: origEnd, replacement: insertParts.join('') });
    }
  }

  // Merge edits separated by short whitespace/punctuation gaps
  const merged: TextEdit[] = [];
  for (const edit of edits) {
    if (merged.length === 0) {
      merged.push(edit);
      continue;
    }
    const prev = merged[merged.length - 1];
    const gap = original.slice(prev.originalEnd, edit.originalStart);
    if (gap.length <= 3 && /^[\s,;.]*$/.test(gap)) {
      prev.originalEnd = edit.originalEnd;
      prev.replacement = prev.replacement + gap + edit.replacement;
    } else {
      merged.push(edit);
    }
  }

  return merged;
}
