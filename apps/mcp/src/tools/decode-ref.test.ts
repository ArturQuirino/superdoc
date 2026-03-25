import { describe, test, expect } from 'bun:test';
import { decodeRef } from './core';

/**
 * Build a valid ref string in the format: "text:<label>:<base64-json>"
 * where the JSON payload is { segments: [{ blockId, start, end }] }
 */
function buildRef(blockId: string, start: number, end: number, label = 'match'): string {
  const payload = JSON.stringify({ segments: [{ blockId, start, end }] });
  const encoded = Buffer.from(payload, 'utf-8').toString('base64');
  return `text:${label}:${encoded}`;
}

describe('decodeRef', () => {
  // -----------------------------------------------------------------------
  // Valid refs
  // -----------------------------------------------------------------------
  test('valid ref returns blockId, start, and end', () => {
    const ref = buildRef('block-1', 0, 10);
    const result = decodeRef(ref);
    expect(result).toEqual({ blockId: 'block-1', start: 0, end: 10 });
  });

  test('valid ref with large offsets', () => {
    const ref = buildRef('paragraph-42', 1500, 2000);
    const result = decodeRef(ref);
    expect(result).toEqual({ blockId: 'paragraph-42', start: 1500, end: 2000 });
  });

  test('valid ref with colons in the label', () => {
    // The label portion could contain colons — the function joins parts[2:]
    const payload = JSON.stringify({ segments: [{ blockId: 'b1', start: 5, end: 15 }] });
    const encoded = Buffer.from(payload, 'utf-8').toString('base64');
    const ref = `text:some:label:${encoded}`;
    // parts.slice(2).join(':') → "label:<encoded>" which is not valid base64 for the full payload
    // Actually: parts = ["text", "some", "label", encoded]
    // parts.slice(2).join(':') → "label:<encoded>" — this won't decode correctly
    // So a ref with extra colons in the label will fail. Let's verify:
    const result = decodeRef(ref);
    // This should return null because "label:<encoded>" is not valid base64 of the original payload
    expect(result).toBeNull();
  });

  test('valid ref where base64 itself contains padding (=)', () => {
    // base64 can have = padding chars — ensure they work
    const ref = buildRef('node-abc', 3, 7);
    const result = decodeRef(ref);
    expect(result).toEqual({ blockId: 'node-abc', start: 3, end: 7 });
  });

  // -----------------------------------------------------------------------
  // Wrong prefix
  // -----------------------------------------------------------------------
  test('wrong prefix returns null', () => {
    const payload = JSON.stringify({ segments: [{ blockId: 'b', start: 0, end: 1 }] });
    const encoded = Buffer.from(payload, 'utf-8').toString('base64');
    expect(decodeRef(`node:match:${encoded}`)).toBeNull();
  });

  test('prefix "TEXT" (uppercase) returns null', () => {
    const payload = JSON.stringify({ segments: [{ blockId: 'b', start: 0, end: 1 }] });
    const encoded = Buffer.from(payload, 'utf-8').toString('base64');
    expect(decodeRef(`TEXT:match:${encoded}`)).toBeNull();
  });

  test('no prefix at all returns null', () => {
    const encoded = Buffer.from('{}', 'utf-8').toString('base64');
    expect(decodeRef(encoded)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Malformed base64
  // -----------------------------------------------------------------------
  test('malformed base64 returns null', () => {
    expect(decodeRef('text:match:not-valid-base64!!!')).toBeNull();
  });

  test('base64 of non-JSON content returns null', () => {
    const encoded = Buffer.from('this is not json', 'utf-8').toString('base64');
    expect(decodeRef(`text:match:${encoded}`)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Valid base64 but missing segments
  // -----------------------------------------------------------------------
  test('valid JSON but empty segments array returns null', () => {
    const encoded = Buffer.from(JSON.stringify({ segments: [] }), 'utf-8').toString('base64');
    expect(decodeRef(`text:match:${encoded}`)).toBeNull();
  });

  test('valid JSON but no segments key returns null', () => {
    const encoded = Buffer.from(JSON.stringify({ blockId: 'b', start: 0, end: 1 }), 'utf-8').toString('base64');
    expect(decodeRef(`text:match:${encoded}`)).toBeNull();
  });

  test('valid JSON but segments is not an array returns null', () => {
    const encoded = Buffer.from(JSON.stringify({ segments: 'not-array' }), 'utf-8').toString('base64');
    expect(decodeRef(`text:match:${encoded}`)).toBeNull();
  });

  test('valid JSON with segments[0] being null returns null', () => {
    const encoded = Buffer.from(JSON.stringify({ segments: [null] }), 'utf-8').toString('base64');
    expect(decodeRef(`text:match:${encoded}`)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Empty / degenerate inputs
  // -----------------------------------------------------------------------
  test('empty string returns null', () => {
    expect(decodeRef('')).toBeNull();
  });

  test('string with only colons returns null', () => {
    expect(decodeRef(':::')).toBeNull();
  });

  test('only "text:" returns null', () => {
    expect(decodeRef('text:')).toBeNull();
  });

  test('"text::" (empty label and data) returns null', () => {
    expect(decodeRef('text::')).toBeNull();
  });

  test('single colon returns null', () => {
    expect(decodeRef(':')).toBeNull();
  });
});
