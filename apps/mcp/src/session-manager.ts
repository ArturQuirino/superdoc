import { access, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, basename, dirname, extname, join } from 'node:path';
import { Editor } from 'superdoc/super-editor';
import { getDocumentApiAdapters } from '@superdoc/super-editor/document-api-adapters';
import { createDocumentApi, type DocumentApi } from '@superdoc/document-api';
import { BLANK_DOCX_BASE64 } from '@superdoc/super-editor/blank-docx';

export type OpenMode = 'copy' | 'edit';

export interface Session {
  id: string;
  /** Original file that was opened (read from). */
  sourcePath: string;
  /** Where save writes by default. */
  savePath: string;
  /** Whether this is a new (blank) document. */
  isNew: boolean;
  editor: Editor;
  api: DocumentApi;
  openedAt: number;
  /** @deprecated Use sourcePath. Kept for v1 compat. */
  get filePath(): string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  async open(filePath: string, opts?: { mode?: OpenMode; outputPath?: string }): Promise<Session> {
    const absolutePath = resolve(filePath);
    const mode = opts?.mode ?? 'copy';

    let bytes: Buffer;
    let isNew = false;

    try {
      await access(absolutePath);
      bytes = await readFile(absolutePath);
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        bytes = Buffer.from(BLANK_DOCX_BASE64, 'base64');
        isNew = true;
      } else {
        throw e;
      }
    }

    const editor = await Editor.open(bytes, {
      documentId: absolutePath,
      user: { id: 'mcp', name: 'MCP Server' },
    });

    const adapters = getDocumentApiAdapters(editor);
    const api = createDocumentApi(adapters);
    const id = generateSessionId(absolutePath);

    // New files always save in-place. Existing files respect mode.
    let savePath: string;
    if (opts?.outputPath) {
      savePath = resolve(opts.outputPath);
    } else if (isNew) {
      savePath = absolutePath;
    } else if (mode === 'copy') {
      savePath = generateCopyPath(absolutePath);
    } else {
      savePath = absolutePath;
    }

    const session: Session = {
      id,
      sourcePath: absolutePath,
      savePath,
      isNew,
      editor,
      api,
      openedAt: Date.now(),
      get filePath() {
        return this.sourcePath;
      },
    };

    this.sessions.set(id, session);
    return session;
  }

  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No open session "${sessionId}". Call superdoc_read or open a document first.`);
    }
    return session;
  }

  async save(sessionId: string, outputPath?: string): Promise<{ path: string; byteLength: number }> {
    const session = this.get(sessionId);
    const targetPath = outputPath ? resolve(outputPath) : session.savePath;

    const exported = await session.editor.exportDocument();
    const bytes = toUint8Array(exported);
    await writeFile(targetPath, bytes);

    return { path: targetPath, byteLength: bytes.byteLength };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.editor.destroy();
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) session.editor.destroy();
    this.sessions.clear();
  }

  list(): Array<{ id: string; filePath: string; openedAt: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      filePath: s.sourcePath,
      openedAt: s.openedAt,
    }));
  }
}

function generateCopyPath(sourcePath: string): string {
  const dir = dirname(sourcePath);
  const ext = extname(sourcePath);
  const stem = basename(sourcePath, ext);
  const suffix = randomBytes(2).toString('hex');
  return join(dir, `${stem}-edited-${suffix}${ext}`);
}

function generateSessionId(filePath: string): string {
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

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error('Exported document data is not binary.');
}
