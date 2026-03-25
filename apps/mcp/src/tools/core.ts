/**
 * SuperDoc MCP tools — 4 core tools.
 *
 * superdoc_read  — get document content
 * superdoc_find  — search text (batch patterns)
 * superdoc_edit  — all mutations (replace, insert, delete, format, comment, accept/reject, undo/redo)
 * superdoc_save  — persist to disk
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session-manager.js';
import { computeWordDiff } from '../word-diff.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(tool: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: `${tool}: ${msg}` }], isError: true };
}

export function decodeRef(ref: string): { blockId: string; start: number; end: number } | null {
  const parts = ref.split(':');
  if (parts.length < 3 || parts[0] !== 'text') return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts.slice(2).join(':'), 'base64').toString('utf-8'));
    return parsed.segments?.[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCoreTools(server: McpServer, sessions: SessionManager): void {
  // ── superdoc_read ─────────────────────────────────────────────────────

  server.registerTool(
    'superdoc_read',
    {
      title: 'Read Document',
      description: 'Read document content, metadata, comments, or tracked changes.',
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        format: z
          .enum(['markdown', 'text', 'html', 'info', 'comments', 'tracked_changes'])
          .optional()
          .describe('Default: "markdown".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, format }) => {
      try {
        const { api } = sessions.get(session_id);
        switch (format ?? 'markdown') {
          case 'markdown':
            return ok({ content: api.getMarkdown({}), info: api.info({}) });
          case 'text':
            return ok({ content: api.getText({}), info: api.info({}) });
          case 'html':
            return ok({ content: api.getHtml({}), info: api.info({}) });
          case 'info':
            return ok(api.info({}));
          case 'comments':
            return ok(api.comments.list());
          case 'tracked_changes':
            return ok(api.trackChanges.list());
        }
      } catch (e) {
        return fail('superdoc_read', e);
      }
    },
  );

  // ── superdoc_find ─────────────────────────────────────────────────────

  server.registerTool(
    'superdoc_find',
    {
      title: 'Find in Document',
      description:
        'Search for text. Pass one string or an array for batch. Returns ref (for edits), block_id + range (for comments), matched_text.',
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        pattern: z.union([z.string(), z.array(z.string())]).describe('Text to find. String or array for batch.'),
        mode: z.enum(['contains', 'regex']).optional().describe('Default: "contains".'),
        case_sensitive: z.boolean().optional().describe('Default: false.'),
        limit: z.number().optional().describe('Max results per pattern. Default: 10.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, pattern, mode, case_sensitive, limit }) => {
      try {
        const { api } = sessions.get(session_id);
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        const results: Record<string, unknown> = {};

        for (const p of patterns) {
          const result = api.query.match({
            select: { type: 'text', pattern: p, mode: mode ?? 'contains', caseSensitive: case_sensitive ?? false },
            limit: limit ?? 10,
          });
          results[p] = {
            total: result.total,
            matches: result.items.map((item: any) => {
              const out: Record<string, unknown> = { ref: item.handle.ref, snippet: item.snippet ?? undefined };
              if (item.blocks?.length > 0) {
                out.matched_text = item.blocks.map((b: any) => b.text).join('');
                out.block_id = item.blocks[0].blockId;
                out.range_start = item.blocks[0].range.start;
                out.range_end = item.blocks[0].range.end;
              }
              return out;
            }),
          };
        }
        return ok(results);
      } catch (e) {
        return fail('superdoc_find', e);
      }
    },
  );

  // ── superdoc_edit ─────────────────────────────────────────────────────

  const opSchema = z.object({
    op: z
      .enum(['replace', 'insert', 'delete', 'format', 'comment', 'accept', 'reject', 'undo', 'redo'])
      .describe('Operation type.'),
    ref: z.string().optional().describe('Ref from superdoc_find. For replace/delete/format.'),
    text: z.string().optional().describe('Text content. For replace/insert/comment.'),
    matched_text: z
      .string()
      .optional()
      .describe('Original text from find. For tracked replace: enables word-level diff.'),
    position: z.enum(['before', 'after']).optional().describe('Insert position relative to ref. Default: "after".'),
    block_id: z.string().optional().describe('Block ID from find. For comment.'),
    range_start: z.number().optional().describe('Range start from find. For comment.'),
    range_end: z.number().optional().describe('Range end from find. For comment.'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    color: z.string().optional().describe('Hex color, e.g. "#ff0000".'),
    highlight: z.string().optional().describe('Highlight hex color.'),
    font_family: z.string().optional(),
    font_size: z.number().optional().describe('Half-points (24 = 12pt).'),
    id: z.string().optional().describe('Tracked change ID. For accept/reject.'),
  });

  server.registerTool(
    'superdoc_edit',
    {
      title: 'Edit Document',
      description: [
        'Apply edits. Pass an array of operations — plan ops (replace/insert/delete/format) execute atomically.',
        'Set tracked=true for redline mode. Include matched_text on replace for word-level diffs.',
      ].join(' '),
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        operations: z.array(opSchema).describe('Array of edit operations.'),
        tracked: z.boolean().optional().describe('Apply replace/insert/delete as tracked changes.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ session_id, operations, tracked }) => {
      try {
        const { api } = sessions.get(session_id);
        const planSteps: Array<Record<string, unknown>> = [];
        const postOps: Array<{ type: string; fn: () => unknown }> = [];
        let stepIdx = 0;

        for (const op of operations) {
          const sid = `s${stepIdx++}`;

          switch (op.op) {
            case 'replace': {
              if (!op.ref) throw new Error(`${sid}: ref required for replace.`);
              if (!op.text) throw new Error(`${sid}: text required for replace.`);

              if (tracked && op.matched_text) {
                const seg = decodeRef(op.ref);
                if (seg) {
                  const edits = computeWordDiff(op.matched_text, op.text);
                  if (edits.length > 0) {
                    for (const edit of edits) {
                      const eid = `s${stepIdx++}`;
                      const target = {
                        kind: 'selection',
                        start: { kind: 'text', blockId: seg.blockId, offset: seg.start + edit.originalStart },
                        end: { kind: 'text', blockId: seg.blockId, offset: seg.start + edit.originalEnd },
                      };
                      if (edit.replacement === '') {
                        planSteps.push({ id: eid, op: 'text.delete', where: { by: 'target', target }, args: {} });
                      } else if (edit.originalStart === edit.originalEnd) {
                        planSteps.push({
                          id: eid,
                          op: 'text.insert',
                          where: { by: 'target', target },
                          args: { position: 'after', content: { text: edit.replacement } },
                        });
                      } else {
                        planSteps.push({
                          id: eid,
                          op: 'text.rewrite',
                          where: { by: 'target', target },
                          args: { replacement: { text: edit.replacement } },
                        });
                      }
                    }
                    break;
                  }
                }
              }
              planSteps.push({
                id: sid,
                op: 'text.rewrite',
                where: { by: 'ref', ref: op.ref },
                args: { replacement: { text: op.text } },
              });
              break;
            }
            case 'insert': {
              if (!op.text) throw new Error(`${sid}: text required for insert.`);
              if (op.ref) {
                planSteps.push({
                  id: sid,
                  op: 'text.insert',
                  where: { by: 'ref', ref: op.ref },
                  args: { position: op.position ?? 'after', content: { text: op.text } },
                });
              } else {
                postOps.push({ type: 'insert', fn: () => api.insert({ value: op.text!, type: 'markdown' } as any) });
              }
              break;
            }
            case 'delete': {
              if (!op.ref) throw new Error(`${sid}: ref required for delete.`);
              planSteps.push({ id: sid, op: 'text.delete', where: { by: 'ref', ref: op.ref }, args: {} });
              break;
            }
            case 'format': {
              if (!op.ref) throw new Error(`${sid}: ref required for format.`);
              const inline: Record<string, unknown> = {};
              const map: Record<string, string> = {
                bold: 'bold',
                italic: 'italic',
                underline: 'underline',
                strike: 'strike',
                color: 'color',
                highlight: 'highlight',
                font_family: 'fontFamily',
                font_size: 'fontSize',
              };
              for (const [from, to] of Object.entries(map)) {
                if ((op as any)[from] !== undefined) inline[to] = (op as any)[from];
              }
              if (Object.keys(inline).length === 0) throw new Error(`${sid}: at least one format property required.`);
              planSteps.push({ id: sid, op: 'format.apply', where: { by: 'ref', ref: op.ref }, args: { inline } });
              break;
            }
            case 'comment': {
              if (!op.text) throw new Error(`${sid}: text required for comment.`);
              if (!op.block_id || op.range_start === undefined || op.range_end === undefined) {
                throw new Error(`${sid}: block_id, range_start, range_end required for comment.`);
              }
              postOps.push({
                type: 'comment',
                fn: () =>
                  api.comments.create({
                    text: op.text!,
                    target: {
                      kind: 'text',
                      blockId: op.block_id!,
                      range: { start: op.range_start!, end: op.range_end! },
                    },
                  }),
              });
              break;
            }
            case 'accept':
            case 'reject': {
              if (!op.id) throw new Error(`${sid}: id required for ${op.op}.`);
              postOps.push({
                type: op.op,
                fn: () => api.trackChanges.decide({ id: op.id!, decision: op.op as any } as any),
              });
              break;
            }
            case 'undo':
              postOps.push({ type: 'undo', fn: () => api.history.undo() });
              break;
            case 'redo':
              postOps.push({ type: 'redo', fn: () => api.history.redo() });
              break;
          }
        }

        const results: Array<Record<string, unknown>> = [];

        if (planSteps.length > 0) {
          const receipt = api.mutations.apply({
            atomic: true,
            changeMode: tracked ? 'tracked' : 'direct',
            steps: planSteps,
          } as any);
          for (const s of (receipt as any).steps ?? []) {
            results.push({ step: s.stepId, op: s.op, effect: s.effect });
          }
        }

        for (const post of postOps) {
          try {
            const r = post.fn();
            results.push({ op: post.type, effect: (r as any)?.success === false ? 'error' : 'changed' });
          } catch (e: any) {
            results.push({ op: post.type, effect: 'error', error: e.message });
          }
        }

        const hasError = results.some((r) => r.effect === 'error');
        return ok({ success: !hasError, count: results.length, results });
      } catch (e) {
        return fail('superdoc_edit', e);
      }
    },
  );

  // ── superdoc_save ─────────────────────────────────────────────────────

  server.registerTool(
    'superdoc_save',
    {
      title: 'Save Document',
      description: 'Save the document to disk.',
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        path: z.string().optional().describe('Override save path.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ session_id, path }) => {
      try {
        return ok(await sessions.save(session_id, path));
      } catch (e) {
        return fail('superdoc_save', e);
      }
    },
  );
}
