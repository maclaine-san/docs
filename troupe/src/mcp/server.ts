// Troupe's MCP server. Claude Code launches one per agent turn over stdio;
// it forwards tool calls to the Troupe app through the local bridge.
import { createInterface } from 'node:readline';
import { TROUPE_TOOLS } from '../shared/tools';

const URL_ = process.env.TROUPE_URL ?? '';
const TOKEN = process.env.TROUPE_TOKEN ?? '';

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    const res = await fetch(`${URL_}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, args }),
    });
    const body = (await res.json()) as { ok?: boolean; text?: string; error?: string };
    return { text: body.text ?? body.error ?? 'No response', isError: !body.ok };
  } catch (err) {
    return { text: `Troupe app is not reachable: ${(err as Error).message}`, isError: true };
  }
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'troupe', version: '0.1.0' },
          instructions: 'Tools for talking to your teammates and managing tasks in Troupe.',
        },
      });
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TROUPE_TOOLS } });
    case 'tools/call': {
      const { text, isError } = await callTool(params?.name, params?.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(msg).catch((err) =>
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } }),
  );
});
rl.on('close', () => process.exit(0));
