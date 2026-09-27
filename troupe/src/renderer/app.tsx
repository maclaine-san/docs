import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ActivityEntry,
  Agent,
  AgentDraft,
  AppState,
  Channel,
  Message,
  Task,
  TaskStatus,
  ToolPreset,
  TroupeApi,
} from '../shared/types';
import { SYSTEM_ID, USER_ID } from '../shared/types';
import { TEMPLATES } from './templates';

const api = (window as unknown as { troupe: TroupeApi }).troupe;

type View =
  | { kind: 'channel'; id: string }
  | { kind: 'agent'; id: string; tab: 'chat' | 'activity' | 'profile' }
  | { kind: 'team' }
  | { kind: 'tasks' }
  | { kind: 'settings' };

const MODELS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];

const TOOL_PRESETS: { value: ToolPreset; label: string; help: string }[] = [
  { value: 'chat', label: 'Chat only', help: 'Talks and manages tasks. No access to your files or the web.' },
  { value: 'research', label: 'Research', help: 'Can search the web and read files in its working directory.' },
  { value: 'builder', label: 'Builder', help: 'Can read, create and edit files, plus a few safe shell commands.' },
  { value: 'autonomous', label: 'Full autonomy', help: 'Skips all permission checks, including any shell command. Only use in a folder you can afford to lose.' },
];

const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ------------------------------------------------------------------ helpers

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Tiny markdown subset: code blocks, inline code, bold, italics, links, @mentions. Input is escaped first. */
function renderMarkdown(src: string): string {
  const blocks = src.split(/```/);
  return blocks
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/^[a-z]*\n/, ''))}</code></pre>`;
      return escapeHtml(part)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        .replace(/(^|\s)@([A-Za-z][\w-]*)/g, '$1<span class="mention">@$2</span>')
        .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
        .replace(/\n/g, '<br/>');
    })
    .join('');
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const HUES = [210, 340, 150, 30, 270, 190, 0, 90, 300, 50];
function hue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

function Avatar({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  if (id === USER_ID) return <div className="avatar you" style={{ width: size, height: size }}>You</div>;
  if (id === SYSTEM_ID) return <div className="avatar sys" style={{ width: size, height: size }}>✦</div>;
  return (
    <div className="avatar" style={{ width: size, height: size, background: `hsl(${hue(id)} 55% 45%)`, fontSize: size * 0.42 }}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

function StatusDot({ agent }: { agent: Agent }) {
  const s = agent.paused ? 'paused' : agent.status;
  const title = { idle: 'Idle', queued: 'Queued: waiting for a free slot', working: 'Working', error: `Error: ${agent.lastError}`, paused: 'Paused' }[s];
  return <span className={`dot ${s}`} title={title} />;
}

function nameOf(state: AppState, id: string): string {
  if (id === USER_ID) return 'You';
  if (id === SYSTEM_ID) return 'Troupe';
  return state.agents.find((a) => a.id === id)?.name ?? 'Former teammate';
}

// ------------------------------------------------------------------ app

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>({ kind: 'team' });
  const [hiring, setHiring] = useState(false);
  const [newChannel, setNewChannel] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    api.getState().then(setState);
    return api.onState(setState);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setToast(errMsg(e));
    }
  };

  if (!state) return <div className="loading">Loading…</div>;

  // Show the team page if the viewed agent or channel no longer exists (or hasn't arrived yet).
  const missing =
    (view.kind === 'agent' && !state.agents.some((a) => a.id === view.id)) ||
    (view.kind === 'channel' && !state.channels.some((c) => c.id === view.id));

  const channels = state.channels.filter((c) => c.kind === 'channel');
  const backchannels = state.channels.filter(
    (c) => c.kind === 'dm' && !c.members.includes(USER_ID) && state.messages.some((m) => m.channelId === c.id),
  );
  const working = state.agents.filter((a) => a.status === 'working').length;
  const queued = state.agents.filter((a) => a.status === 'queued').length;
  const openTasks = state.tasks.filter((t) => t.status !== 'done').length;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand drag">
          <span className="logo">◆</span> Troupe
        </div>
        <button className={`pause ${state.settings.paused ? 'on' : ''}`} onClick={() => run(() => api.updateSettings({ paused: !state.settings.paused }))}>
          {state.settings.paused ? '▶ Resume team' : '❚❚ Pause team'}
        </button>
        <div className="load">
          {working} working · {queued} queued · max {state.settings.maxConcurrent}
        </div>

        <nav>
          <NavItem active={view.kind === 'team'} onClick={() => setView({ kind: 'team' })} label="Team" />
          <NavItem active={view.kind === 'tasks'} onClick={() => setView({ kind: 'tasks' })} label="Tasks" badge={openTasks || undefined} />

          <div className="section">
            Channels <button className="plus" title="New channel" onClick={() => setNewChannel(true)}>+</button>
          </div>
          {channels.map((c) => (
            <NavItem key={c.id} active={view.kind === 'channel' && view.id === c.id} onClick={() => setView({ kind: 'channel', id: c.id })} label={`# ${c.name}`} />
          ))}
          {!channels.length && <div className="empty-nav">Hire someone to get #general</div>}

          <div className="section">
            Agents <button className="plus" title="Hire an agent" onClick={() => setHiring(true)}>+</button>
          </div>
          {state.agents.map((a) => (
            <NavItem
              key={a.id}
              active={view.kind === 'agent' && view.id === a.id}
              onClick={() => setView({ kind: 'agent', id: a.id, tab: 'chat' })}
              label={a.name}
              sub={a.role}
              dot={<StatusDot agent={a} />}
            />
          ))}

          {backchannels.length > 0 && <div className="section">Backchannel</div>}
          {backchannels.map((c) => (
            <NavItem
              key={c.id}
              active={view.kind === 'channel' && view.id === c.id}
              onClick={() => setView({ kind: 'channel', id: c.id })}
              label={c.members.map((m) => nameOf(state, m)).join(' ↔ ')}
              muted
            />
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="primary block" onClick={() => setHiring(true)}>Hire an agent</button>
          <NavItem active={view.kind === 'settings'} onClick={() => setView({ kind: 'settings' })} label="Settings" />
        </div>
      </aside>

      <main>
        {(view.kind === 'team' || missing) && <TeamView state={state} open={(id) => setView({ kind: 'agent', id, tab: 'chat' })} hire={() => setHiring(true)} />}
        {view.kind === 'tasks' && <TasksView state={state} run={run} />}
        {view.kind === 'settings' && <SettingsView state={state} run={run} />}
        {view.kind === 'channel' && !missing && <ChannelView key={view.id} state={state} channelId={view.id} run={run} />}
        {view.kind === 'agent' && !missing && (
          <AgentView key={view.id} state={state} agentId={view.id} tab={view.tab} setTab={(tab) => setView({ ...view, tab })} run={run} />
        )}
      </main>

      {hiring && (
        <HireDialog
          state={state}
          close={() => setHiring(false)}
          hire={async (d) => {
            try {
              const a = await api.hireAgent(d);
              setHiring(false);
              setView({ kind: 'agent', id: a.id, tab: 'chat' });
            } catch (e) {
              setToast(errMsg(e));
            }
          }}
        />
      )}
      {newChannel && (
        <ChannelDialog
          state={state}
          close={() => setNewChannel(false)}
          save={async (name, members, topic) => {
            try {
              const c = await api.createChannel(name, members, topic);
              setNewChannel(false);
              setView({ kind: 'channel', id: c.id });
            } catch (e) {
              setToast(errMsg(e));
            }
          }}
        />
      )}
      {toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}
    </div>
  );
}

function NavItem(p: { active: boolean; onClick: () => void; label: string; sub?: string; badge?: number; dot?: React.ReactNode; muted?: boolean }) {
  return (
    <button className={`nav ${p.active ? 'active' : ''} ${p.muted ? 'muted' : ''}`} onClick={p.onClick}>
      {p.dot}
      <span className="nav-label">
        {p.label}
        {p.sub && <span className="nav-sub">{p.sub}</span>}
      </span>
      {p.badge ? <span className="badge">{p.badge}</span> : null}
    </button>
  );
}

// ------------------------------------------------------------------ team

function TeamView({ state, open, hire }: { state: AppState; open: (id: string) => void; hire: () => void }) {
  if (!state.agents.length) {
    return (
      <div className="page center">
        <div className="hero">
          <div className="hero-logo">◆</div>
          <h1>Build your team</h1>
          <p>
            Hire Claude agents, give each a role and responsibilities, and let them delegate to and message each other. Every agent is a
            persistent Claude Code session running on your Claude subscription.
          </p>
          <button className="primary" onClick={hire}>Hire your first agent</button>
          <p className="hint">Tip: start with a Chief of Staff, then hire specialists who report to them.</p>
        </div>
      </div>
    );
  }
  const children = (id: string) => state.agents.filter((a) => (a.reportsTo || '') === id && (id === '' || state.agents.some((m) => m.id === id)));
  const roots = state.agents.filter((a) => !a.reportsTo || !state.agents.some((m) => m.id === a.reportsTo));
  const node = (a: Agent): React.ReactNode => (
    <li key={a.id}>
      <button className="org-card" onClick={() => open(a.id)}>
        <Avatar id={a.id} name={a.name} size={36} />
        <div>
          <div className="org-name">
            {a.name} <StatusDot agent={a} />
          </div>
          <div className="org-role">{a.role}</div>
          <div className="org-meta">
            {a.model || state.settings.defaultModel || 'default'} · {TOOL_PRESETS.find((t) => t.value === a.tools)?.label} ·{' '}
            {state.tasks.filter((t) => t.assigneeId === a.id && t.status !== 'done').length} open tasks
          </div>
        </div>
      </button>
      {children(a.id).length > 0 && <ul>{children(a.id).map(node)}</ul>}
    </li>
  );
  const totalCost = state.agents.reduce((s, a) => s + a.costUsd, 0);
  return (
    <div className="page">
      <header className="page-head">
        <h2>Team</h2>
        <span className="muted">
          {state.agents.length} agents · {state.agents.reduce((s, a) => s + a.turns, 0)} turns · ≈${totalCost.toFixed(2)} API-equivalent
          usage
        </span>
      </header>
      <div className="org">
        <div className="org-root">
          <Avatar id={USER_ID} name="You" size={36} /> <strong>You</strong>
        </div>
        <ul>{roots.map(node)}</ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ chat

function ChannelView({ state, channelId, run, embedded }: { state: AppState; channelId: string; run: (f: () => Promise<unknown>) => void; embedded?: boolean }) {
  const channel = state.channels.find((c) => c.id === channelId);
  const [editing, setEditing] = useState(false);
  if (!channel) return null;
  const isBackchannel = channel.kind === 'dm' && !channel.members.includes(USER_ID);
  const title = channel.kind === 'channel' ? `# ${channel.name}` : channel.members.map((m) => nameOf(state, m)).join(' ↔ ');
  const members = channel.members.filter((m) => m !== USER_ID);

  return (
    <div className={`chat ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <header className="page-head drag">
          <h2>{title}</h2>
          {channel.topic && <span className="muted">{channel.topic}</span>}
          <div className="spacer" />
          {channel.kind === 'channel' && (
            <>
              <div className="stack">
                {members.slice(0, 6).map((m) => (
                  <Avatar key={m} id={m} name={nameOf(state, m)} size={22} />
                ))}
              </div>
              <button onClick={() => setEditing(true)}>Members</button>
            </>
          )}
          <button onClick={() => confirm('Clear all messages in this conversation?') && run(() => api.clearMessages(channel.id))}>Clear</button>
        </header>
      )}
      <Messages state={state} channelId={channel.id} />
      {isBackchannel ? (
        <div className="readonly">Agents' private conversation. You can read it, but only they post here.</div>
      ) : (
        <Composer state={state} channel={channel} run={run} />
      )}
      {editing && (
        <ChannelDialog
          state={state}
          channel={channel}
          close={() => setEditing(false)}
          remove={() => confirm(`Delete #${channel.name}?`) && run(() => api.deleteChannel(channel.id))}
          save={async (name, m, topic) => {
            run(() => api.updateChannel(channel.id, { name, members: m, topic }));
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function Messages({ state, channelId }: { state: AppState; channelId: string }) {
  const msgs = state.messages.filter((m) => m.channelId === channelId);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);
  const typing = state.channels
    .find((c) => c.id === channelId)
    ?.members.filter((m) => state.agents.find((a) => a.id === m)?.status === 'working');

  return (
    <div
      className="messages"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {!msgs.length && <div className="empty">No messages yet.</div>}
      {msgs.map((m, i) => {
        const prev = msgs[i - 1];
        const grouped = prev && prev.from === m.from && m.ts - prev.ts < 5 * 60_000 && m.from !== SYSTEM_ID;
        return <MessageRow key={m.id} state={state} m={m} grouped={Boolean(grouped)} />;
      })}
      {typing && typing.length > 0 && (
        <div className="typing">
          {typing.map((id) => nameOf(state, id)).join(', ')} {typing.length === 1 ? 'is' : 'are'} working<span className="ellipsis" />
        </div>
      )}
    </div>
  );
}

function MessageRow({ state, m, grouped }: { state: AppState; m: Message; grouped: boolean }) {
  if (m.from === SYSTEM_ID) return <div className="sysmsg" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />;
  const agent = state.agents.find((a) => a.id === m.from);
  return (
    <div className={`msg ${grouped ? 'grouped' : ''}`}>
      <div className="msg-gutter">{!grouped && <Avatar id={m.from} name={nameOf(state, m.from)} />}</div>
      <div className="msg-body">
        {!grouped && (
          <div className="msg-head">
            <strong>{nameOf(state, m.from)}</strong>
            {agent && <span className="role">{agent.role}</span>}
            <span className="time">{timeLabel(m.ts)}</span>
            {m.taskId && <span className="chip">{m.taskId}</span>}
          </div>
        )}
        <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
      </div>
    </div>
  );
}

function Composer({ state, channel, run }: { state: AppState; channel: Channel; run: (f: () => Promise<unknown>) => void }) {
  const [text, setText] = useState('');
  const members = channel.members.filter((m) => m !== USER_ID).map((m) => state.agents.find((a) => a.id === m)).filter(Boolean) as Agent[];
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    run(() => api.sendMessage(channel.id, t));
  };
  const placeholder =
    channel.kind === 'dm'
      ? `Message ${members[0]?.name ?? ''}`
      : `Message #${channel.name}: everyone here reads it, or @mention someone to wake only them`;
  return (
    <div className="composer">
      {channel.kind === 'channel' && members.length > 0 && (
        <div className="mentions">
          {['all', ...members.map((m) => m.name)].map((n) => (
            <button key={n} onClick={() => setText((t) => (t && !t.endsWith(' ') ? t + ' ' : t) + `@${n} `)}>@{n}</button>
          ))}
        </div>
      )}
      <textarea
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
      />
      <button className="primary" onClick={send} disabled={!text.trim()}>Send</button>
    </div>
  );
}

// ------------------------------------------------------------------ agent

function AgentView(p: { state: AppState; agentId: string; tab: 'chat' | 'activity' | 'profile'; setTab: (t: 'chat' | 'activity' | 'profile') => void; run: (f: () => Promise<unknown>) => void }) {
  const { state, agentId, tab, setTab, run } = p;
  const agent = state.agents.find((a) => a.id === agentId)!;
  const [dmId, setDmId] = useState<string>('');
  useEffect(() => {
    api.openDm(agentId).then((c) => setDmId(c.id));
  }, [agentId]);
  const manager = agent.reportsTo ? state.agents.find((a) => a.id === agent.reportsTo)?.name : 'You';

  return (
    <div className="agent-page">
      <header className="agent-head drag">
        <Avatar id={agent.id} name={agent.name} size={40} />
        <div>
          <h2>
            {agent.name} <StatusDot agent={agent} />
          </h2>
          <div className="muted">
            {agent.role} · reports to {manager}
          </div>
        </div>
        <div className="spacer" />
        {agent.status === 'working' && <button onClick={() => run(() => api.stopAgent(agent.id))}>■ Stop</button>}
        {agent.status === 'error' || agent.paused ? (
          <button className="primary" onClick={() => run(() => api.updateAgent(agent.id, { paused: false }))}>▶ Resume</button>
        ) : (
          <button onClick={() => run(() => api.updateAgent(agent.id, { paused: true }))}>❚❚ Pause</button>
        )}
      </header>
      {agent.status === 'error' && (
        <div className="banner error">
          <strong>On hold after an error.</strong> Queued messages are kept. Fix the cause (e.g. wait out a usage limit) and press Resume.
          <pre>{agent.lastError}</pre>
        </div>
      )}
      <div className="tabs">
        {(['chat', 'activity', 'profile'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {{ chat: 'Chat', activity: 'Activity', profile: 'Profile' }[t]}
          </button>
        ))}
      </div>
      {tab === 'chat' && dmId && <ChannelView state={state} channelId={dmId} run={run} embedded />}
      {tab === 'activity' && <ActivityView agent={agent} />}
      {tab === 'profile' && <ProfileView key={agent.id + agent.profileVersion} state={state} agent={agent} run={run} />}
    </div>
  );
}

function ActivityView({ agent }: { agent: Agent }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.getActivity(agent.id).then(setEntries);
    return api.onActivity((e) => {
      if (e.agentId === agent.id) setEntries((xs) => [...xs.slice(-399), e]);
    });
  }, [agent.id]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);
  return (
    <div className="activity" ref={ref}>
      {!entries.length && <div className="empty">Nothing yet. Live tool calls and thinking-out-loud show up here while {agent.name} works.</div>}
      {entries.map((e) => (
        <div key={e.id} className={`act ${e.kind}`}>
          <span className="time">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className="kind">{{ turn_start: '▶', text: '💬', tool: '🔧', tool_result: '↳', turn_end: '■', error: '⚠', stderr: '⚠' }[e.kind]}</span>
          <span className="act-text">{e.text}</span>
        </div>
      ))}
      <div className="act-foot">
        {agent.turns} turns · ≈${agent.costUsd.toFixed(3)} API-equivalent usage · session {agent.sessionId.slice(0, 8)}
      </div>
    </div>
  );
}

function AgentForm({ state, value, onChange, selfId }: { state: AppState; value: AgentDraft; onChange: (d: AgentDraft) => void; selfId?: string }) {
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="form">
      <div className="row2">
        <label>
          Name
          <input value={value.name} onChange={(e) => set('name', e.target.value.replace(/\s/g, ''))} placeholder="e.g. Maya" autoFocus />
          <small>Teammates @mention and message them by this name.</small>
        </label>
        <label>
          Role
          <input value={value.role} onChange={(e) => set('role', e.target.value)} placeholder="e.g. Product Manager" />
        </label>
      </div>
      <label>
        Responsibilities
        <textarea rows={5} value={value.responsibilities} onChange={(e) => set('responsibilities', e.target.value)} placeholder="What does this agent own? What does good work look like?" />
      </label>
      <label>
        Extra instructions <small>(optional)</small>
        <textarea rows={3} value={value.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder="Tone, constraints, conventions, things to never do…" />
      </label>
      <div className="row3">
        <label>
          Reports to
          <select value={value.reportsTo} onChange={(e) => set('reportsTo', e.target.value)}>
            <option value="">You</option>
            {state.agents
              .filter((a) => a.id !== selfId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
          </select>
        </label>
        <label>
          Model
          <select value={value.model} onChange={(e) => set('model', e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.value ? m.label : `Default (${state.settings.defaultModel || 'CLI default'})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Heartbeat
          <select value={value.heartbeatMinutes} onChange={(e) => set('heartbeatMinutes', Number(e.target.value))}>
            <option value={0}>Off (only when messaged)</option>
            <option value={15}>Every 15 min</option>
            <option value={60}>Every hour</option>
            <option value={240}>Every 4 hours</option>
            <option value={1440}>Daily</option>
          </select>
        </label>
      </div>
      <div className="field">
        <div className="field-label">Permissions</div>
        <div className="presets">
          {TOOL_PRESETS.map((t) => (
            <button key={t.value} className={`preset ${value.tools === t.value ? 'active' : ''} ${t.value === 'autonomous' ? 'danger' : ''}`} onClick={() => set('tools', t.value)} type="button">
              <strong>{t.label}</strong>
              <span>{t.help}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="row2">
        <label>
          Working directory
          <div className="inline">
            <input value={value.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder={state.settings.workspaceDir} />
            <button
              type="button"
              onClick={async () => {
                const d = await api.chooseDirectory();
                if (d) set('cwd', d);
              }}
            >
              Choose…
            </button>
          </div>
        </label>
        <label className="check">
          <input type="checkbox" checked={value.useMyMcpServers} onChange={(e) => set('useMyMcpServers', e.target.checked)} />
          Also load my Claude Code MCP servers
        </label>
      </div>
    </div>
  );
}

function toDraft(a: Agent): AgentDraft {
  const { name, role, responsibilities, instructions, model, reportsTo, tools, useMyMcpServers, cwd, heartbeatMinutes } = a;
  return { name, role, responsibilities, instructions, model, reportsTo, tools, useMyMcpServers, cwd, heartbeatMinutes };
}

function ProfileView({ state, agent, run }: { state: AppState; agent: Agent; run: (f: () => Promise<unknown>) => void }) {
  const [draft, setDraft] = useState<AgentDraft>(toDraft(agent));
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(agent));
  return (
    <div className="page scroll">
      <AgentForm state={state} value={draft} onChange={setDraft} selfId={agent.id} />
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={() => run(() => api.updateAgent(agent.id, draft))}>Save changes</button>
        {dirty && <button onClick={() => setDraft(toDraft(agent))}>Discard</button>}
        <div className="spacer" />
        <button onClick={() => confirm(`Reset ${agent.name}'s memory? They start a fresh Claude session; messages and tasks stay.`) && run(() => api.resetAgentMemory(agent.id))}>Reset memory</button>
        <button className="danger" onClick={() => confirm(`Fire ${agent.name}? Their open tasks become unassigned.`) && run(() => api.fireAgent(agent.id))}>Fire</button>
      </div>
      {dirty && agent.sessionStarted && <p className="hint">Changes to role, responsibilities or instructions are briefed to {agent.name} at the start of their next turn.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ hire / channel dialogs

function Modal({ title, close, children, wide }: { title: string; close: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <header>
          <h3>{title}</h3>
          <button className="x" onClick={close}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

function HireDialog({ state, close, hire }: { state: AppState; close: () => void; hire: (d: AgentDraft) => void }) {
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const lead = state.agents.find((a) => /chief|lead|manager|ceo|head/i.test(a.role));
  return (
    <Modal title="Hire an agent" close={close} wide>
      {!draft ? (
        <div className="templates">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              className="template"
              onClick={() => setDraft({ ...t.draft, name: '', cwd: '', reportsTo: t.key === 'lead' ? '' : lead?.id ?? '' })}
            >
              <strong>{t.label}</strong>
              <span>{t.blurb}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <AgentForm state={state} value={draft} onChange={setDraft} />
          <div className="actions">
            <button onClick={() => setDraft(null)}>← Templates</button>
            <div className="spacer" />
            <button className="primary" disabled={!draft.name || !draft.role} onClick={() => hire(draft)}>Hire {draft.name}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ChannelDialog(p: { state: AppState; channel?: Channel; close: () => void; save: (name: string, members: string[], topic: string) => void; remove?: () => void }) {
  const [name, setName] = useState(p.channel?.name ?? '');
  const [topic, setTopic] = useState(p.channel?.topic ?? '');
  const [members, setMembers] = useState<string[]>(p.channel?.members.filter((m) => m !== USER_ID) ?? p.state.agents.map((a) => a.id));
  return (
    <Modal title={p.channel ? `#${p.channel.name}` : 'New channel'} close={p.close}>
      <div className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="e.g. launch" autoFocus />
        </label>
        <label>
          Topic
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is this channel for?" />
        </label>
        <div className="field">
          <div className="field-label">Members</div>
          <div className="checks">
            {p.state.agents.map((a) => (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={members.includes(a.id)}
                  onChange={(e) => setMembers((ms) => (e.target.checked ? [...ms, a.id] : ms.filter((x) => x !== a.id)))}
                />
                {a.name} <span className="muted">{a.role}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="actions">
        {p.remove && <button className="danger" onClick={p.remove}>Delete channel</button>}
        <div className="spacer" />
        <button className="primary" disabled={!name} onClick={() => p.save(name, members, topic)}>{p.channel ? 'Save' : 'Create'}</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ tasks

function TasksView({ state, run }: { state: AppState; run: (f: () => Promise<unknown>) => void }) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string>('');
  const cols: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
  const sorted = useMemo(() => [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt), [state.tasks]);
  const task = state.tasks.find((t) => t.id === open);
  return (
    <div className="page">
      <header className="page-head drag">
        <h2>Tasks</h2>
        <span className="muted">Agents create and update these with their tools. You can too.</span>
        <div className="spacer" />
        <button className="primary" onClick={() => setAdding(true)} disabled={!state.agents.length}>New task</button>
      </header>
      <div className="board">
        {cols.map((c) => (
          <div key={c} className="col">
            <div className="col-head">
              {STATUS_LABEL[c]} <span className="muted">{sorted.filter((t) => t.status === c).length}</span>
            </div>
            {sorted
              .filter((t) => t.status === c)
              .map((t) => (
                <button key={t.id} className="card" onClick={() => setOpen(t.id)}>
                  <div className="card-top">
                    <span className="chip">{t.id}</span>
                    {t.assigneeId ? <Avatar id={t.assigneeId} name={nameOf(state, t.assigneeId)} size={20} /> : <span className="muted">unassigned</span>}
                  </div>
                  <div className="card-title">{t.title}</div>
                  <div className="card-meta">
                    {nameOf(state, t.assigneeId || '')} · from {nameOf(state, t.createdBy)} · {timeLabel(t.updatedAt)}
                  </div>
                </button>
              ))}
          </div>
        ))}
      </div>
      {adding && <NewTaskDialog state={state} close={() => setAdding(false)} run={run} />}
      {task && (
        <Modal title={`${task.id}: ${task.title}`} close={() => setOpen('')} wide>
          <div className="form">
            <div className="row2">
              <label>
                Status
                <select value={task.status} onChange={(e) => run(() => api.updateTask(task.id, { status: e.target.value as TaskStatus }))}>
                  {cols.map((c) => (
                    <option key={c} value={c}>
                      {STATUS_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Assignee
                <select value={task.assigneeId} onChange={(e) => run(() => api.updateTask(task.id, { assigneeId: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {state.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field">
              <div className="field-label">Description</div>
              <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.description || '_No description_') }} />
            </div>
            <div className="field">
              <div className="field-label">Result</div>
              <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.result || 'Nothing yet.') }} />
            </div>
            <div className="muted">
              Created by {nameOf(state, task.createdBy)} · {new Date(task.createdAt).toLocaleString()}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewTaskDialog({ state, close, run }: { state: AppState; close: () => void; run: (f: () => Promise<unknown>) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssignee] = useState(state.agents[0]?.id ?? '');
  return (
    <Modal title="New task" close={close}>
      <div className="form">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label>
          Description
          <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should be delivered? Any context or constraints?" />
        </label>
        <label>
          Assign to
          <select value={assigneeId} onChange={(e) => setAssignee(e.target.value)}>
            {state.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <div className="spacer" />
        <button
          className="primary"
          disabled={!title || !assigneeId}
          onClick={() => {
            run(() => api.createTask({ title, description, assigneeId }));
            close();
          }}
        >
          Create and notify
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ settings

function SettingsView({ state, run }: { state: AppState; run: (f: () => Promise<unknown>) => void }) {
  const s = state.settings;
  const [check, setCheck] = useState<{ ok: boolean; path: string; version: string; error?: string } | null>(null);
  const [claudePath, setClaudePath] = useState(s.claudePath);
  useEffect(() => {
    api.checkClaude().then(setCheck);
  }, [s.claudePath]);
  return (
    <div className="page scroll">
      <header className="page-head drag">
        <h2>Settings</h2>
      </header>
      <div className="form narrow">
        <div className={`banner ${check?.ok ? 'ok' : 'error'}`}>
          {!check ? (
            'Checking for Claude Code…'
          ) : check.ok ? (
            <>
              <strong>Claude Code found</strong>: {check.version} at <code>{check.path}</code>. Agents run through this CLI and use whatever account
              it's logged into. Run <code>claude</code> in Terminal and use <code>/login</code> to sign in with your Pro or Max plan.
            </>
          ) : (
            <>
              <strong>Claude Code not available.</strong> {check.error} Install it with <code>curl -fsSL https://claude.ai/install.sh | bash</code>, then run{' '}
              <code>claude</code> once and log in with your subscription.
            </>
          )}
        </div>
        <label>
          Claude CLI path <small>(leave empty to auto-detect)</small>
          <div className="inline">
            <input value={claudePath} onChange={(e) => setClaudePath(e.target.value)} placeholder={check?.path || '/usr/local/bin/claude'} />
            <button onClick={() => run(() => api.updateSettings({ claudePath: claudePath.trim() }))}>Save</button>
          </div>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.forceSubscription} onChange={(e) => run(() => api.updateSettings({ forceSubscription: e.target.checked }))} />
          Use my Claude subscription: ignore <code>ANTHROPIC_API_KEY</code> so agents never bill an API key
        </label>
        <label>
          Shared workspace folder
          <div className="inline">
            <input value={s.workspaceDir} readOnly />
            <button
              onClick={async () => {
                const d = await api.chooseDirectory();
                if (d) run(() => api.updateSettings({ workspaceDir: d }));
              }}
            >
              Choose…
            </button>
          </div>
          <small>Agents run here unless they have their own working directory. Builders can edit files in it.</small>
        </label>
        <div className="row3">
          <label>
            Agents working at once
            <input type="number" min={1} max={10} value={s.maxConcurrent} onChange={(e) => run(() => api.updateSettings({ maxConcurrent: Number(e.target.value) }))} />
            <small>Keep this at 1–3 on a subscription so you don't burn through usage limits.</small>
          </label>
          <label>
            Loop limit (hops)
            <input type="number" min={1} max={50} value={s.maxDepth} onChange={(e) => run(() => api.updateSettings({ maxDepth: Number(e.target.value) }))} />
            <small>Agent-to-agent messages allowed after one message from you before the team waits for you.</small>
          </label>
          <label>
            Default model
            <select value={s.defaultModel} onChange={(e) => run(() => api.updateSettings({ defaultModel: e.target.value }))}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.value ? m.label : 'CLI default'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
