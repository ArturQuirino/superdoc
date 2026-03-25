/**
 * Shared MCP server setup — used by both stdio and http transports.
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from './session-manager.js';
import { registerCoreTools } from './tools/core.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const instructions = `SuperDoc MCP — read, edit, and save Word documents (.docx).
Do NOT use python-docx, unpack scripts, or manual XML editing.

## Tools

superdoc_open — open a .docx (mode="copy" saves to new file, "edit" saves in-place)
superdoc_read — get content (markdown, text, html, info, comments, tracked_changes)
superdoc_find — search text, pass array for batch. Returns ref + block_id + range.
superdoc_edit — all changes: replace, insert, delete, format, comment, accept/reject, undo/redo
superdoc_save — write to disk
superdoc_close — release session

## Workflow

open → read → find (batch all patterns) → edit (batch all operations) → save → close

## Tips

- Batch all patterns in one find call, all edits in one edit call.
- For redlining: tracked=true + matched_text on replace ops.
- For comments: use block_id + range_start + range_end from find.
- For new documents: open non-existent path, then insert without ref.`;

export function createSuperdocServer(): { server: McpServer; sessions: SessionManager } {
  const server = new McpServer({ name: 'superdoc', version }, { instructions });
  const sessions = new SessionManager();

  // --- Lifecycle ---

  server.registerTool(
    'superdoc_open',
    {
      title: 'Open Document',
      description: "Open a .docx file. Creates blank if path doesn't exist. Returns session_id.",
      inputSchema: {
        path: z.string().describe('Path to .docx file.'),
        mode: z.enum(['copy', 'edit']).optional().describe('"copy" (default) or "edit" (in-place).'),
        output_path: z.string().optional().describe('Explicit save path.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ path, mode, output_path }) => {
      try {
        const session = await sessions.open(path, { mode: mode ?? 'copy', outputPath: output_path });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { session_id: session.id, source: session.sourcePath, save_to: session.savePath },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `superdoc_open: ${e.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'superdoc_close',
    {
      title: 'Close Document',
      description: 'Close session. Unsaved changes are lost.',
      inputSchema: { session_id: z.string().describe('Session ID.') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ session_id }) => {
      try {
        await sessions.close(session_id);
        return { content: [{ type: 'text' as const, text: '{"closed":true}' }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `superdoc_close: ${e.message}` }], isError: true };
      }
    },
  );

  // --- Core tools ---
  registerCoreTools(server, sessions);

  return { server, sessions };
}
