#!/usr/bin/env node
/**
 * SuperDoc MCP Server — HTTP streamable transport (self-hosted).
 *
 * Usage: bun run src/http.ts [--port 3100]
 *
 * Clients connect via: POST http://localhost:3100/mcp
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createSuperdocServer } from './server.js';

const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '3100', 10);

const { server, sessions } = createSuperdocServer();

const transports = new Map<string, StreamableHTTPServerTransport>();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  // MCP endpoint
  if (url.pathname === '/mcp') {
    // Check for existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // New session
    if (req.method === 'POST' && !sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      await server.connect(transport);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }

      await transport.handleRequest(req, res);
      return;
    }

    // Session not found
    if (sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(port, () => {
  console.log(`SuperDoc MCP server listening on http://localhost:${port}/mcp`);
  console.log(`Health check: http://localhost:${port}/health`);
});

const shutdown = async () => {
  await sessions.closeAll();
  httpServer.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
