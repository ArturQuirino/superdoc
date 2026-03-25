#!/usr/bin/env node
/**
 * SuperDoc MCP Server — stdio transport.
 *
 * Usage: bun run src/index.ts
 * Or:    superdoc-mcp (via npx @superdoc-dev/mcp)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSuperdocServer } from './server.js';

const { server, sessions } = createSuperdocServer();

await server.connect(new StdioServerTransport());

process.on('SIGINT', async () => {
  await sessions.closeAll();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await sessions.closeAll();
  process.exit(0);
});
