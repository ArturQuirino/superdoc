import { describe, test, expect } from 'bun:test';
import { computeWordDiff, type TextEdit } from './word-diff';

describe('computeWordDiff', () => {
  // -----------------------------------------------------------------------
  // Identical strings
  // -----------------------------------------------------------------------
  test('identical strings return empty array', () => {
    expect(computeWordDiff('hello world', 'hello world')).toEqual([]);
  });

  test('identical single word returns empty array', () => {
    expect(computeWordDiff('hello', 'hello')).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Empty inputs
  // -----------------------------------------------------------------------
  test('empty original returns single insertion', () => {
    const edits = computeWordDiff('', 'hello world');
    expect(edits).toHaveLength(1);
    expect(edits[0].originalStart).toBe(0);
    expect(edits[0].originalEnd).toBe(0);
    expect(edits[0].replacement).toBe('hello world');
  });

  test('empty replacement returns single deletion', () => {
    const edits = computeWordDiff('hello world', '');
    expect(edits).toHaveLength(1);
    expect(edits[0].originalStart).toBe(0);
    expect(edits[0].originalEnd).toBe('hello world'.length);
    expect(edits[0].replacement).toBe('');
  });

  test('both empty returns empty array', () => {
    expect(computeWordDiff('', '')).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Pure insertion
  // -----------------------------------------------------------------------
  test('insertion at end', () => {
    const edits = computeWordDiff('hello', 'hello world');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // The inserted content should contain "world"
    const allReplacements = edits.map((e) => e.replacement).join('');
    expect(allReplacements).toContain('world');
  });

  test('insertion at start', () => {
    const edits = computeWordDiff('world', 'hello world');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const allReplacements = edits.map((e) => e.replacement).join('');
    expect(allReplacements).toContain('hello');
  });

  test('insertion in middle', () => {
    const edits = computeWordDiff('hello world', 'hello beautiful world');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const allReplacements = edits.map((e) => e.replacement).join('');
    expect(allReplacements).toContain('beautiful');
  });

  // -----------------------------------------------------------------------
  // Pure deletion
  // -----------------------------------------------------------------------
  test('deletion of a word', () => {
    const edits = computeWordDiff('hello beautiful world', 'hello world');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // At least one edit should remove "beautiful" (replacement should not include it)
    const deletedRange = edits.find((e) =>
      'hello beautiful world'.slice(e.originalStart, e.originalEnd).includes('beautiful'),
    );
    expect(deletedRange).toBeDefined();
  });

  test('deletion of first word', () => {
    const edits = computeWordDiff('hello world', 'world');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // Some edit should cover the "hello" range
    const coversHello = edits.some((e) => e.originalStart <= 0 && e.originalEnd > 0);
    expect(coversHello).toBe(true);
  });

  test('deletion of last word', () => {
    const edits = computeWordDiff('hello world', 'hello');
    expect(edits.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Word replacement
  // -----------------------------------------------------------------------
  test('single word replacement', () => {
    const edits = computeWordDiff('hello world', 'hello earth');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // The edit should target "world" and replace with "earth"
    const replaceEdit = edits.find((e) => e.replacement.includes('earth'));
    expect(replaceEdit).toBeDefined();
    const original = 'hello world';
    const replaced = original.slice(replaceEdit!.originalStart, replaceEdit!.originalEnd);
    expect(replaced).toContain('world');
  });

  test('multiple word replacement', () => {
    const edits = computeWordDiff('the quick brown fox', 'the slow red fox');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // Should replace "quick brown" with "slow red"
    const allReplacements = edits.map((e) => e.replacement).join(' ');
    expect(allReplacements).toContain('slow');
    expect(allReplacements).toContain('red');
  });

  // -----------------------------------------------------------------------
  // Scattered changes (multiple positions with unchanged text between)
  // -----------------------------------------------------------------------
  test('scattered changes in a long string', () => {
    const original = 'The quick brown fox jumps over the lazy dog today';
    const replacement = 'The slow brown fox jumps over the active dog today';
    const edits = computeWordDiff(original, replacement);

    // Should produce at least one edit for "quick" -> "slow" and one for "lazy" -> "active"
    // (may be separate or merged depending on gap)
    expect(edits.length).toBeGreaterThanOrEqual(1);

    // Verify the edits don't cover the entire string — only changed portions
    const totalEditSpan = edits.reduce((sum, e) => sum + (e.originalEnd - e.originalStart), 0);
    expect(totalEditSpan).toBeLessThan(original.length);

    // Apply edits to verify correctness
    const result = applyEdits(original, edits);
    expect(result).toBe(replacement);
  });

  test('changes at start and end with long unchanged middle', () => {
    const original = 'AAA the middle is unchanged ZZZ';
    const replacement = 'BBB the middle is unchanged YYY';
    const edits = computeWordDiff(original, replacement);

    expect(edits.length).toBeGreaterThanOrEqual(2);
    const result = applyEdits(original, edits);
    expect(result).toBe(replacement);
  });

  // -----------------------------------------------------------------------
  // Adjacent edit merging
  // -----------------------------------------------------------------------
  test('edits separated by short punctuation merge', () => {
    // If two edits are separated by <= 3 chars of whitespace/punctuation, they merge
    const original = 'a, b, c';
    const replacement = 'x, y, c';
    const edits = computeWordDiff(original, replacement);

    // "a" -> "x" and "b" -> "y" are separated by ", " (2 chars) so should merge
    // into one edit
    expect(edits).toHaveLength(1);
  });

  test('edits separated by long gap stay separate', () => {
    const original = 'The quick brown fox jumps over the lazy dog';
    const replacement = 'The slow brown fox jumps over the active dog';
    const edits = computeWordDiff(original, replacement);

    // "quick" -> "slow" and "lazy" -> "active" separated by "brown fox jumps over the"
    // which is much longer than 3 chars, so they stay separate
    expect(edits.length).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // Single character and single word strings
  // -----------------------------------------------------------------------
  test('single character replacement', () => {
    const edits = computeWordDiff('a', 'b');
    expect(edits).toHaveLength(1);
    expect(edits[0].originalStart).toBe(0);
    expect(edits[0].originalEnd).toBe(1);
    expect(edits[0].replacement).toBe('b');
  });

  test('single word to different single word', () => {
    const edits = computeWordDiff('hello', 'goodbye');
    expect(edits).toHaveLength(1);
    expect(edits[0].originalStart).toBe(0);
    expect(edits[0].originalEnd).toBe(5);
    expect(edits[0].replacement).toBe('goodbye');
  });

  // -----------------------------------------------------------------------
  // Edit correctness (apply and verify)
  // -----------------------------------------------------------------------
  test('applying edits reconstructs the replacement string', () => {
    const cases = [
      ['hello world', 'hello beautiful world'],
      ['the cat sat on the mat', 'the dog lay on the rug'],
      ['abc def ghi', 'abc xyz ghi'],
      ['one two three four five', 'one TWO three FOUR five'],
    ] as const;

    for (const [original, replacement] of cases) {
      const edits = computeWordDiff(original, replacement);
      const result = applyEdits(original, edits);
      expect(result).toBe(replacement);
    }
  });
});

/**
 * Apply a list of TextEdits to the original string to produce the result.
 * Edits must be non-overlapping and sorted by originalStart (which computeWordDiff guarantees).
 */
function applyEdits(original: string, edits: TextEdit[]): string {
  let result = '';
  let cursor = 0;
  for (const edit of edits) {
    result += original.slice(cursor, edit.originalStart);
    result += edit.replacement;
    cursor = edit.originalEnd;
  }
  result += original.slice(cursor);
  return result;
}
