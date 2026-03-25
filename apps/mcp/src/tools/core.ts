/**
 * SuperDoc Tools v2 — 5 purpose-driven tools, zero overlap.
 *
 * superdoc_read  — get document content
 * superdoc_find  — search text/nodes (batch patterns)
 * superdoc_edit  — all mutations (replace, insert, delete, format, comment, accept/reject)
 * superdoc_save  — persist to disk
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../session-manager.js';
import { computeWordDiff } from '../word-diff.js';
import { ok, err } from '../response.js';

export function decodeRef(ref: string): { blockId: string; start: number; end: number } | null {
  const parts = ref.split(':');
  if (parts.length < 3 || parts[0] !== 'text') return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts.slice(2).join(':'), 'base64').toString('utf-8'));
    if (parsed.segments?.[0]) return parsed.segments[0];
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCoreTools(server: McpServer, sessions: SessionManager): void {
  // =========================================================================
  // superdoc_read — get document content
  // =========================================================================
  server.registerTool(
    'superdoc_read',
    {
      title: 'Read Document',
      description:
        'Read document content. Returns markdown/text/html content, document info, or tracked changes/comments list.',
      inputSchema: {
        session_id: z.string().describe('Session ID from open.'),
        format: z
          .enum(['markdown', 'text', 'html', 'info', 'comments', 'tracked_changes'])
          .optional()
          .describe(
            'What to read. Default: "markdown". Use "info" for structure/metadata, "comments" or "tracked_changes" to list those.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, format }) => {
      const t = performance.now();
      try {
        const { api } = sessions.get(session_id);
        const f = format ?? 'markdown';
        switch (f) {
          case 'markdown':
            return ok({ content: api.getMarkdown({}), info: api.info({}) }, ms(t));
          case 'text':
            return ok({ content: api.getText({}), info: api.info({}) }, ms(t));
          case 'html':
            return ok({ content: api.getHtml({}) }, ms(t));
          case 'info':
            return ok(api.info({}), ms(t));
          case 'comments':
            return ok(api.comments.list(), ms(t));
          case 'tracked_changes':
            return ok(api.trackChanges.list(), ms(t));
        }
      } catch (e) {
        return err('superdoc_read', e);
      }
    },
  );

  // =========================================================================
  // superdoc_find — search text/nodes (batch)
  // =========================================================================
  server.registerTool(
    'superdoc_find',
    {
      title: 'Find in Document',
      description:
        'Search for text patterns. Pass one string or an array to batch. Returns ref (for edits), block_id + range (for comments), and matched_text per match.',
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        pattern: z
          .union([z.string(), z.array(z.string())])
          .describe('Text to find. String or array of strings for batch.'),
        mode: z.enum(['contains', 'regex']).optional().describe('Default: "contains".'),
        case_sensitive: z.boolean().optional().describe('Default: false.'),
        limit: z.number().optional().describe('Max results per pattern. Default: 10.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, pattern, mode, case_sensitive, limit }) => {
      const t = performance.now();
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
              const out: Record<string, unknown> = {
                ref: item.handle.ref,
                snippet: item.snippet ?? undefined,
              };
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
        return ok(results, ms(t));
      } catch (e) {
        return err('superdoc_find', e);
      }
    },
  );

  // =========================================================================
  // superdoc_edit — all mutations
  // =========================================================================

  const opSchema = z.object({
    op: z
      .enum([
        'replace',
        'insert',
        'delete',
        'format',
        'comment',
        'accept',
        'reject',
        'undo',
        'redo',
        'set_style',
        'list_indent',
        'list_outdent',
      ])
      .describe('Operation type.'),
    // Targeting
    ref: z.string().optional().describe('Ref from superdoc_find. For replace/delete/format.'),
    // Content
    text: z.string().optional().describe('Text content. For replace/insert/comment.'),
    matched_text: z
      .string()
      .optional()
      .describe('Original text from find. For tracked replace: enables word-level diff.'),
    // Insert positioning
    position: z.enum(['before', 'after']).optional().describe('Insert position relative to ref. Default: "after".'),
    // Comment targeting (flat)
    block_id: z.string().optional().describe('Block ID from find. For comment.'),
    range_start: z.number().optional().describe('Range start from find. For comment.'),
    range_end: z.number().optional().describe('Range end from find. For comment.'),
    // Formatting (flat)
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    color: z.string().optional().describe('Hex color, e.g. "#ff0000".'),
    highlight: z.string().optional().describe('Highlight hex color.'),
    font_family: z.string().optional(),
    font_size: z.number().optional().describe('Half-points (24 = 12pt).'),
    // Style
    style_id: z.string().optional().describe('Named paragraph style for set_style.'),
    // Track change targeting
    id: z.string().optional().describe('Tracked change ID. For accept/reject.'),
    // List targeting
    target: z.unknown().optional().describe('Block address for list operations.'),
  });

  server.registerTool(
    'superdoc_edit',
    {
      title: 'Edit Document',
      description: [
        'Apply edits to the document. Pass an array of operations — they execute atomically.',
        '',
        'Ops: replace, insert, delete, format, comment, accept, reject, undo, redo, set_style, list_indent, list_outdent.',
        'Set tracked=true for redline mode (tracked changes). Include matched_text on replace for word-level diffs.',
      ].join('\n'),
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        operations: z.array(opSchema).describe('Array of edit operations.'),
        tracked: z.boolean().optional().describe('Apply replace/insert/delete as tracked changes.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ session_id, operations, tracked }) => {
      const t = performance.now();
      try {
        const { api } = sessions.get(session_id);

        const planSteps: Array<Record<string, unknown>> = [];
        const postOps: Array<{ type: string; fn: () => unknown }> = [];
        let stepIdx = 0;

        for (const op of operations) {
          const sid = `s${stepIdx++}`;

          switch (op.op) {
            // --- Text mutations (go through plan engine) ---
            case 'replace': {
              if (!op.ref) throw new Error(`${sid}: ref required for replace.`);
              if (!op.text) throw new Error(`${sid}: text required for replace.`);

              // Word-level diff for tracked changes
              if (tracked && op.matched_text) {
                const seg = decodeRef(op.ref);
                if (seg) {
                  const edits = computeWordDiff(op.matched_text, op.text);
                  if (edits.length > 0) {
                    for (const edit of edits) {
                      const editId = `s${stepIdx++}`;
                      const target = {
                        kind: 'selection',
                        start: { kind: 'text', blockId: seg.blockId, offset: seg.start + edit.originalStart },
                        end: { kind: 'text', blockId: seg.blockId, offset: seg.start + edit.originalEnd },
                      };
                      if (edit.replacement === '') {
                        planSteps.push({ id: editId, op: 'text.delete', where: { by: 'target', target }, args: {} });
                      } else if (edit.originalStart === edit.originalEnd) {
                        planSteps.push({
                          id: editId,
                          op: 'text.insert',
                          where: { by: 'target', target },
                          args: { position: 'after', content: { text: edit.replacement } },
                        });
                      } else {
                        planSteps.push({
                          id: editId,
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
              // Fallback: whole-match replace
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
                // Ref-less: append via direct API (after plan)
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
              if (op.bold !== undefined) inline.bold = op.bold;
              if (op.italic !== undefined) inline.italic = op.italic;
              if (op.underline !== undefined) inline.underline = op.underline;
              if (op.strike !== undefined) inline.strike = op.strike;
              if (op.color !== undefined) inline.color = op.color;
              if (op.highlight !== undefined) inline.highlight = op.highlight;
              if (op.font_family !== undefined) inline.fontFamily = op.font_family;
              if (op.font_size !== undefined) inline.fontSize = op.font_size;
              if (Object.keys(inline).length === 0) throw new Error(`${sid}: at least one format property required.`);
              planSteps.push({ id: sid, op: 'format.apply', where: { by: 'ref', ref: op.ref }, args: { inline } });
              break;
            }

            // --- Comments (direct API, after plan) ---
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

            // --- Track change decisions (direct API) ---
            case 'accept':
            case 'reject': {
              if (!op.id) throw new Error(`${sid}: id required for ${op.op}.`);
              postOps.push({
                type: op.op,
                fn: () => api.trackChanges.decide({ id: op.id!, decision: op.op as 'accept' | 'reject' } as any),
              });
              break;
            }

            // --- History ---
            case 'undo':
              postOps.push({ type: 'undo', fn: () => api.history.undo() });
              break;
            case 'redo':
              postOps.push({ type: 'redo', fn: () => api.history.redo() });
              break;

            // --- Paragraph style ---
            case 'set_style': {
              if (!op.ref && !op.target) throw new Error(`${sid}: ref or target required for set_style.`);
              const setStyleFn = (api as any).styles?.paragraph?.setStyle;
              if (typeof setStyleFn !== 'function')
                throw new Error(`${sid}: api.styles.paragraph.setStyle is not available.`);
              postOps.push({
                type: 'set_style',
                fn: () =>
                  setStyleFn({
                    target: op.target ?? { kind: 'text', blockId: decodeRef(op.ref!)?.blockId },
                    styleId: op.style_id,
                  }),
              });
              break;
            }

            // --- List operations ---
            case 'list_indent':
            case 'list_outdent': {
              const listOp = op.op === 'list_indent' ? 'indent' : 'outdent';
              const listFn = (api.lists as any)?.[listOp];
              if (typeof listFn !== 'function') throw new Error(`${sid}: api.lists.${listOp} is not available.`);
              postOps.push({
                type: op.op,
                fn: () => listFn({ target: op.target, input: {} }),
              });
              break;
            }
          }
        }

        // Execute plan steps atomically
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

        // Execute post-plan operations
        for (const post of postOps) {
          try {
            const r = post.fn();
            results.push({ op: post.type, effect: (r as any)?.success === false ? 'error' : 'changed' });
          } catch (e: any) {
            results.push({ op: post.type, effect: 'error', error: e.message });
          }
        }

        const hasError = results.some((r) => r.effect === 'error');
        return ok({ success: !hasError, count: results.length, results }, ms(t));
      } catch (e) {
        return err('superdoc_edit', e);
      }
    },
  );

  // =========================================================================
  // superdoc_save — persist to disk
  // =========================================================================
  server.registerTool(
    'superdoc_save',
    {
      title: 'Save Document',
      description: 'Save the document to disk. Writes to the path from open, or override with path.',
      inputSchema: {
        session_id: z.string().describe('Session ID.'),
        path: z.string().optional().describe('Override save path.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ session_id, path }) => {
      const t = performance.now();
      try {
        const result = await sessions.save(session_id, path);
        return ok(result, ms(t));
      } catch (e) {
        return err('superdoc_save', e);
      }
    },
  );
}

function ms(start: number): number {
  return Math.round(performance.now() - start);
}
