import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Orchestrator, ToolError } from './orchestrator';

/**
 * Localhost HTTP endpoint that Troupe's MCP server (running inside each
 * claude process) calls to execute tools. Each agent has its own bearer
 * token, so an agent can only act as itself.
 */
export function startBridge(orch: Orchestrator): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/tool') return reply(404, { error: 'not found' });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const agentId = orch.agentForToken(token);
    if (!agentId) return reply(401, { error: 'unauthorized' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { name, args } = JSON.parse(body || '{}');
        const text = await orch.handleTool(agentId, String(name), args && typeof args === 'object' ? args : {});
        reply(200, { ok: true, text });
      } catch (err) {
        const msg = err instanceof ToolError ? err.message : `Internal error: ${(err as Error).message}`;
        reply(200, { ok: false, text: msg });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
