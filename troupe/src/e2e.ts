// Headless end-to-end run against the real claude CLI (uses a little of your subscription).
//   npm run e2e
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './core/store';
import { Orchestrator } from './core/orchestrator';
import { ClaudeCliRunner, childEnv, findClaude, loginShellPath } from './core/claudeRunner';
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
  });
  orch.start();
  const base = { emoji: '●', hue: 0, model: 'haiku', capability: 'chat' as const };
  orch.addAgent({ ...base, name: 'Nova', isLead: true, persona: 'Team lead. Delegates writing to Quill.' });
  orch.addAgent({ ...base, name: 'Quill', isLead: false, persona: 'Poet who writes very short poems.' });
  orch.on('live', (l) => l.length && console.log('  ·', l.map((x: any) => orch.state.agents.find((a) => a.id === x.agentId)?.name + (x.step ? ` (${x.step})` : '')).join(', ')));

  const chat = orch.newChat('group');
  orch.userMessage(chat.id, 'Ask Quill for a two-line poem about the ocean, then give it to me with a one-line comment of your own.');

  const started = Date.now();
  while (orch.isBusy() || orch.state.inbox.length) {
    if (Date.now() - started > 5 * 60_000) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n=== Chat ===');
  for (const m of orch.state.messages) {
    const who = m.from === USER_ID ? 'You' : orch.state.agents.find((a) => a.id === m.from)?.name ?? m.from;
    console.log(`${who}: ${m.text}\n`);
  }
  const names = orch.state.messages.map((m) => orch.state.agents.find((a) => a.id === m.from)?.name ?? m.from);
  const cost = orch.state.agents.reduce((s, a) => s + a.costUsd, 0);
  console.log(`Turns: ${orch.state.usage.turnsToday}, API-equivalent cost: $${cost.toFixed(4)}, 5h usage: ${orch.state.usage.fiveHour?.utilization ?? 'n/a'}`);
  orch.shutdown();
  const ok = names.join(',') === 'user,Nova,Quill,Nova';
  console.log(ok ? 'PASS' : `FAIL: unexpected flow ${names.join(' → ')}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
