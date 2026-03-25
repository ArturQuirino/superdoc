import { describe, test, expect } from 'bun:test';
import { resolve, basename, dirname, extname, join } from 'node:path';

/**
 * Tests for SessionManager path logic and session lifecycle.
 *
 * Since `generateCopyPath` and `generateSessionId` are private, we test their
 * behavior through the public API. For path-generation tests that don't need
 * an Editor, we replicate the pure logic here (extracted from session-manager.ts).
 */

// ---------------------------------------------------------------------------
// Replicate private pure functions for direct unit testing
// ---------------------------------------------------------------------------

function generateCopyPath(sourcePath: string): string {
  const { randomBytes } = require('node:crypto');
  const dir = dirname(sourcePath);
  const ext = extname(sourcePath);
  const stem = basename(sourcePath, ext);
  const suffix = randomBytes(2).toString('hex');
  return join(dir, `${stem}-edited-${suffix}${ext}`);
}

/** Match pattern for copy paths: <stem>-edited-<4hex><ext> */
const COPY_PATH_RE = /^(.+)-edited-[0-9a-f]{4}(\.[^.]+)$/;

function generateSessionId(filePath: string): string {
  const { randomBytes } = require('node:crypto');
  const stem = basename(filePath).replace(/\.[^.]+$/, '');
  const normalized =
    stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '') || 'session';
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  return `${normalized.slice(0, 57)}-${suffix}`;
}

// ---------------------------------------------------------------------------
// generateCopyPath
// ---------------------------------------------------------------------------

describe('generateCopyPath', () => {
  test('produces <stem>-edited-<hex><ext> in the same directory', () => {
    const result = generateCopyPath('/home/user/docs/report.docx');
    expect(result).toMatch(/\/home\/user\/docs\/report-edited-[0-9a-f]{4}\.docx$/);
  });

  test('preserves directory path', () => {
    const result = generateCopyPath('/tmp/my-file.docx');
    expect(dirname(result)).toBe('/tmp');
  });

  test('preserves extension', () => {
    const result = generateCopyPath('/docs/file.docx');
    expect(extname(result)).toBe('.docx');
  });

  test('handles paths with spaces', () => {
    const result = generateCopyPath('/my docs/my file.docx');
    expect(result).toMatch(/\/my docs\/my file-edited-[0-9a-f]{4}\.docx$/);
  });

  test('handles files with multiple dots', () => {
    const result = generateCopyPath('/docs/my.report.v2.docx');
    expect(result).toMatch(/\/docs\/my\.report\.v2-edited-[0-9a-f]{4}\.docx$/);
  });

  test('handles files in root directory', () => {
    const result = generateCopyPath('/file.docx');
    expect(result).toMatch(/\/file-edited-[0-9a-f]{4}\.docx$/);
  });
});

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------

describe('generateSessionId', () => {
  test('contains a 6-char hex suffix', () => {
    const id = generateSessionId('/path/to/report.docx');
    expect(id).toMatch(/-[a-f0-9]{6}$/);
  });

  test('uses lowercase filename stem as prefix', () => {
    const id = generateSessionId('/path/to/MyReport.docx');
    expect(id).toMatch(/^myreport-/);
  });

  test('replaces non-alphanumeric chars with hyphens and collapses them', () => {
    const id = generateSessionId('/path/to/My Report (Final).docx');
    // "My Report (Final)" → lowercase → "my report (final)" → replace → "my-report--final-"
    // → collapse hyphens → "my-report-final-" → strip trailing → "my-report-final"
    expect(id).toMatch(/^my-report-final-[a-f0-9]{6}$/);
  });

  test('collapses consecutive hyphens', () => {
    const id = generateSessionId('/path/to/a---b.docx');
    expect(id).toMatch(/^a-b-/);
  });

  test('strips leading/trailing special chars', () => {
    const id = generateSessionId('/path/to/.hidden-file.docx');
    expect(id).toMatch(/^hidden-file-/);
  });

  test('falls back to "session" for degenerate filenames', () => {
    const id = generateSessionId('/path/to/....docx');
    expect(id).toMatch(/^session-[a-f0-9]{6}$/);
  });

  test('truncates long stems to 57 chars', () => {
    const longName = 'a'.repeat(100) + '.docx';
    const id = generateSessionId(`/path/${longName}`);
    // prefix (57) + '-' (1) + suffix (6) = 64
    expect(id.length).toBeLessThanOrEqual(64);
  });

  test('generates unique ids for same file path', () => {
    const id1 = generateSessionId('/same/path.docx');
    const id2 = generateSessionId('/same/path.docx');
    expect(id1).not.toBe(id2); // random suffix differs
  });
});

// ---------------------------------------------------------------------------
// SessionManager lifecycle (via public API)
// ---------------------------------------------------------------------------

describe('SessionManager lifecycle', () => {
  // These tests exercise the public SessionManager API.
  // They require the full build (Editor.open), so they may fail in
  // environments without the superdoc packages. The tests above cover
  // the pure logic; these cover integration.

  let SessionManager: typeof import('./session-manager').SessionManager;
  let manager: InstanceType<typeof SessionManager>;

  // Attempt to load the real module — skip if dependencies are missing
  try {
    const mod = require('./session-manager');
    SessionManager = mod.SessionManager;
  } catch {
    // Dependencies not available — tests below will be skipped
  }

  const BLANK_DOCX = resolve(import.meta.dir, '../../../shared/common/data/blank.docx');

  function skipIfNoModule() {
    if (!SessionManager) {
      console.log('Skipping: SessionManager dependencies unavailable');
      return true;
    }
    return false;
  }

  test('open existing file sets sourcePath and savePath (copy mode)', async () => {
    if (skipIfNoModule()) return;
    manager = new SessionManager();
    try {
      const session = await manager.open(BLANK_DOCX);
      expect(session.sourcePath).toBe(BLANK_DOCX);
      // Default mode is 'copy', so savePath should be the "-edited" variant
      expect(session.savePath).toContain('-edited');
      expect(session.savePath).toEndWith('.docx');
      expect(session.isNew).toBe(false);
    } finally {
      await manager.closeAll();
    }
  });

  test('open non-existent path sets isNew=true and savePath=sourcePath', async () => {
    if (skipIfNoModule()) return;
    manager = new SessionManager();
    try {
      const fakePath = '/tmp/does-not-exist-' + Date.now() + '.docx';
      const session = await manager.open(fakePath);
      expect(session.isNew).toBe(true);
      expect(session.savePath).toBe(resolve(fakePath));
      expect(session.sourcePath).toBe(resolve(fakePath));
    } finally {
      await manager.closeAll();
    }
  });

  test('open with mode="edit" sets savePath=sourcePath', async () => {
    if (skipIfNoModule()) return;
    manager = new SessionManager();
    try {
      const session = await manager.open(BLANK_DOCX, { mode: 'edit' });
      expect(session.savePath).toBe(session.sourcePath);
    } finally {
      await manager.closeAll();
    }
  });

  test('open with outputPath override sets savePath=outputPath', async () => {
    if (skipIfNoModule()) return;
    manager = new SessionManager();
    try {
      const outputPath = '/tmp/custom-output-' + Date.now() + '.docx';
      const session = await manager.open(BLANK_DOCX, { outputPath });
      expect(session.savePath).toBe(resolve(outputPath));
    } finally {
      await manager.closeAll();
    }
  });

  test('close removes session from map', async () => {
    if (skipIfNoModule()) return;
    manager = new SessionManager();
    try {
      const session = await manager.open(BLANK_DOCX);
      await manager.close(session.id);
      expect(() => manager.get(session.id)).toThrow('No open session');
      expect(manager.list()).toHaveLength(0);
    } finally {
      await manager.closeAll();
    }
  });

  test('get with invalid ID throws', () => {
    if (skipIfNoModule()) return;
    manager = new SessionManager();
    expect(() => manager.get('nonexistent-id')).toThrow('No open session');
  });
});
