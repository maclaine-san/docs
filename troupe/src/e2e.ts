// Headless end-to-end run against the real claude CLI (uses your subscription).
//   npm run e2e
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './core/store';
import { Orchestrator } from './core/orchestrator';
import { ClaudeCliRunner, childEnv, findClaude, loginShellPath } from './core/claudeRunner';
import { startBridge } from './core/bridge';
import { displayName, channelLabel } from './core/prompts';
import { USER_ID } from './shared/types';

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-e2e-'));
  const pathVar = await loginShellPath();
  const claudePath = findClaude(pathVar);
  if (!claudePath) throw new Error('claude CLI not found on PATH');
  const store = new Store(dataDir);
  const orch = new Orchestrator(store, new ClaudeCliRunner(), {
    claudePath,
    childEnv: () => childEnv(pathVar, store.state.settings.forceSubscription),
    mcpCommand: process.execPath,
    mcpArgs: [path.join(__dirname, 'mcp.js')],
    mcpEnv: {},
  });
  const bridge = await startBridge(orch);
  orch.start(bridge.url);
  orch.updateSettings({ defaultModel: process.env.TROUPE_MODEL ?? 'haiku' });
  orch.on('activity', (e) => {
    const who = orch.state.agents.find((a) => a.id === e.agentId)?.name;
    console.log(`  · ${who} ${e.kind}: ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  });

  const base = { instructions: '', model: '', tools: 'chat' as const, useMyMcpServers: false, cwd: '', heartbeatMinutes: 0 };
  const maya = orch.hireAgent({ ...base, name: 'Maya', role: 'Project Manager', responsibilities: 'Break requests from the user into tasks, delegate them to the right teammate, and report results back to the user.', reportsTo: '' });
  orch.hireAgent({ ...base, name: 'Leo', role: 'Copywriter', responsibilities: 'Write short, vivid copy and poems on request.', reportsTo: maya.id });

  const dm = orch.dm(USER_ID, maya.id);
  orch.userMessage(dm.id, 'Please have Leo write a two-line poem about the ocean via a task, then send me the poem once he is done.');

  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      const busy = orch.state.agents.some((a) => orch.isRunning(a.id)) || orch.state.inbox.length > 0;
      if (!busy) { clearInterval(t); resolve(); }
      if (Date.now() - started > 8 * 60_000) { clearInterval(t); reject(new Error('timeout')); }
    }, 1000);
  });

  console.log('\n=== Transcript ===');
  for (const m of orch.state.messages) {
    console.log(`[${channelLabel(orch.state, m.channelId, USER_ID)}] ${displayName(orch.state, m.from)} (depth ${m.depth}): ${m.text}\n`);
  }
  console.log('=== Tasks ===');
  for (const t of orch.state.tasks) console.log(`${t.id} [${t.status}] ${t.title} -> ${t.result}`);
  const errs = orch.state.agents.filter((a) => a.status === 'error');
  orch.shutdown();
  bridge.close();
  const replied = orch.state.messages.some((m) => m.channelId === dm.id && m.from === maya.id);
  const done = orch.state.tasks.some((t) => t.status === 'done');
  console.log(`\nMaya replied to user: ${replied}; a task was completed: ${done}; errors: ${errs.map((a) => a.lastError).join(' | ') || 'none'}`);
  process.exit(replied && done && !errs.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
