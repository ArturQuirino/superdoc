#!/usr/bin/env node
/**
 * SuperDoc MCP Server
 *
 * 6 tools: superdoc_open, superdoc_read, superdoc_find, superdoc_edit,
 *          superdoc_save, superdoc_close
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionManager } from './session-manager.js';
import { registerCoreTools } from './tools/core.js';
import { err } from './response.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const instructions = `SuperDoc MCP — read, edit, and save Word documents (.docx).
Do NOT use python-docx, unpack scripts, or manual XML editing. Use these tools instead.

## Tools

superdoc_open(path, mode?) — open a .docx. mode="copy" (default) saves to new file; "edit" saves in-place.
superdoc_read(session_id, format?) — get content: markdown (default), text, html, info, comments, tracked_changes.
superdoc_find(session_id, pattern) — search text. Pass array of patterns for batch. Returns ref + block_id + range.
superdoc_edit(session_id, operations, tracked?) — all changes: replace, insert, delete, format, comment, accept/reject.
superdoc_save(session_id, path?) — write to disk.
superdoc_close(session_id) — release session.

## Workflow

open → read → find (batch all patterns) → edit (batch all operations) → save → close

## Tips

- Batch everything: all patterns in one find, all edits in one edit call.
- For redlining: tracked=true + include matched_text on replace ops for word-level changes.
- For comments: use block_id + range_start + range_end from find results.
- For new documents: open non-existent path, then op="insert" without ref (appends markdown).`;

const server = new McpServer({ name: 'superdoc', version }, { instructions });
const sessions = new SessionManager();

// --- Lifecycle tools ---

server.registerTool(
  'superdoc_open',
  {
    title: 'Open Document',
    description:
      "Open a .docx file for reading and editing. Creates blank if path doesn't exist. Returns session_id for all other tools.",
    inputSchema: {
      path: z.string().describe('Path to .docx file.'),
      mode: z
        .enum(['copy', 'edit'])
        .optional()
        .describe('"copy" (default) saves to new "-edited" file. "edit" saves in-place.'),
      output_path: z.string().optional().describe('Explicit save path. Overrides mode.'),
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
              {
                session_id: session.id,
                source: session.sourcePath,
                save_to: session.savePath,
                mode: session.savePath === session.sourcePath ? 'edit' : 'copy',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (e) {
      return err('superdoc_open', e);
    }
  },
);

server.registerTool(
  'superdoc_close',
  {
    title: 'Close Document',
    description: 'Close session and release memory. Unsaved changes are lost.',
    inputSchema: {
      session_id: z.string().describe('Session ID to close.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ session_id }) => {
    try {
      await sessions.close(session_id);
      return { content: [{ type: 'text' as const, text: '{"closed":true}' }] };
    } catch (e) {
      return err('superdoc_close', e);
    }
  },
);

// --- Core tools ---
registerCoreTools(server, sessions);

// --- Transport ---
const transport = new StdioServerTransport();

async function main(): Promise<void> {
  await server.connect(transport);
}

main().catch((err) => {
  console.error('SuperDoc MCP server failed:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await sessions.closeAll();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await sessions.closeAll();
  process.exit(0);
});
