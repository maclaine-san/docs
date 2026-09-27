import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent, AgentDraft, AppState, Capability, Chat, LiveStatus, Message, Project, ProjectReadAccess, TroupeApi } from '../shared/types';
import { canEditFiles, SYSTEM_ID, USER_ID } from '../shared/types';
import { EMOJIS, PRESETS, SUGGESTIONS } from './templates';

const api = (window as unknown as { troupe: TroupeApi }).troupe;

const MODELS = [
  { value: 'haiku', label: 'Haiku: fastest, lightest on usage' },
  { value: 'sonnet', label: 'Sonnet: smarter, balanced' },
  { value: 'opus', label: 'Opus: most capable, heaviest' },
];

const CAPABILITIES: { value: Capability; label: string }[] = [
  { value: 'chat', label: 'Just chat (lightest)' },
  { value: 'web', label: 'Search the web' },
  { value: 'files', label: 'Web + read and edit files' },
  { value: 'code', label: 'Code: files + run tests, builds, git status/diff' },
  { value: 'full', label: 'Everything, no permission checks (risky)' },
];

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Small markdown subset. Input is escaped first, so the output is safe to inject. */
function renderMarkdown(src: string, agents: Agent[]): string {
  const names = new Set(agents.map((a) => a.name.toLowerCase()));
  return src
    .split(/```/)
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/^[\w-]*\n/, ''))}</code></pre>`;
      const lines = escapeHtml(part).split('\n');
      let html = '';
      let list: 'ul' | 'ol' | '' = '';
      const close = () => {
        if (list) html += `</${list}>`;
        list = '';
      };
      for (const raw of lines) {
        const inline = (s: string) =>
          s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
            .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
            .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>')
            .replace(/(^|[\s(])@(?:&quot;([^&\n]+?)&quot;|([\w~.\/-]*[.\/][\w~.\/-]*\w))/g, (_m, pre, q, p) => `${pre}<span class="file-mention">${q ?? p}</span>`)
            .replace(/(^|[\s(])@([A-Za-z][\w-]*)/g, (m, pre, n) => (names.has(n.toLowerCase()) ? `${pre}<span class="mention">@${n}</span>` : m));
        const ul = /^\s*[-*•] (.*)$/.exec(raw);
        const ol = /^\s*\d+[.)] (.*)$/.exec(raw);
        const h = /^#{1,4} (.*)$/.exec(raw);
        const quote = /^&gt; ?(.*)$/.exec(raw);
        if (ul || ol) {
          const kind = ul ? 'ul' : 'ol';
          if (list !== kind) {
            close();
            html += `<${kind}>`;
            list = kind;
          }
          html += `<li>${inline((ul ?? ol)![1])}</li>`;
          continue;
        }
        close();
        if (h) html += `<h4>${inline(h[1])}</h4>`;
        else if (quote) html += `<blockquote>${inline(quote[1])}</blockquote>`;
        else if (raw.trim()) html += `<p>${inline(raw)}</p>`;
      }
      close();
      return html;
    })
    .join('');
}

function dayGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Older';
}

function Avatar({ agent, size = 30 }: { agent?: Agent; size?: number }) {
  if (!agent) return <div className="avatar ghost" style={{ width: size, height: size }}>?</div>;
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.5, background: `hsl(${agent.hue} 70% 55% / 0.18)`, color: `hsl(${agent.hue} 60% 45%)` }}>
      {agent.emoji}
    </div>
  );
}

function nameStyle(a?: Agent) {
  return a ? { color: `hsl(${a.hue} 55% var(--name-l))` } : undefined;
}

// ------------------------------------------------------------------ app

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [live, setLive] = useState<LiveStatus[]>([]);
  const [chatId, setChatId] = useState('');
  /** Id of the project whose page is open, or "" when a chat is shown. */
  const [projectPage, setProjectPage] = useState('');
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    api.getState().then(setState);
    api.getLive().then(setLive);
    const a = api.onState(setState);
    const b = api.onLive(setLive);
    return () => (a(), b());
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      setToast(errMsg(e));
    }
  };

  const chats = useMemo(() => [...(state?.chats ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [state?.chats]);
  const chat = state?.chats.find((c) => c.id === chatId);

  /** Switch to a chat as soon as it exists, without waiting for the next state push. */
  const openChat = async (make: () => Promise<Chat>) => {
    const c = await run(make);
    if (!c) return;
    setState(await api.getState());
    setChatId(c.id);
    setProjectPage('');
    return c;
  };
  const showChat = (id: string) => {
    setChatId(id);
    setProjectPage('');
  };

  // Opened from the quick window or a notification.
  useEffect(() => api.onOpenChat((id) => showChat(id)), []);

  // Dropping a file anywhere must not navigate the window away.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => (window.removeEventListener('dragover', stop), window.removeEventListener('drop', stop));
  }, []);

  // Open the most recent chat, or make one.
  useEffect(() => {
    if (!state || chat) return;
    if (chats.length) setChatId(chats[0].id);
    else openChat(() => api.newChat('group'));
  }, [state, chat, chats]);

  const newChat = () => openChat(() => api.newChat(chat?.target ?? 'group', projectPage || chat?.projectId || ''));

  const createProject = async (folders: string[] | null) => {
    const dirs = folders ?? (await api.chooseDirectories());
    if (!dirs.length) return;
    const p = await run(() => api.createProject('', dirs));
    if (!p) return;
    setState(await api.getState());
    setProjectPage(p.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!state || !chat) return <div className="loading">◆</div>;

  const hasMessages = (c: Chat) => state.messages.some((m) => m.chatId === c.id);
  const openProject = state.projects.find((p) => p.id === projectPage);
  const activeProjectId = openProject?.id ?? chat.projectId;
  const projects = [...state.projects].sort((a, b) => a.name.localeCompare(b.name));
  const grouped: [string, Chat[]][] = [];
  for (const c of chats.filter((c) => hasMessages(c) && !c.projectId)) {
    const g = dayGroup(c.updatedAt);
    const last = grouped.at(-1);
    if (last && last[0] === g) last[1].push(c);
    else grouped.push([g, [c]]);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand drag">
          <span className="logo">◆</span> Troupe
        </div>
        <button className="new-chat" onClick={newChat}>
          <span>✎</span>
          <span className="new-chat-label">New chat{activeProjectId ? ` in ${state.projects.find((p) => p.id === activeProjectId)?.name ?? 'project'}` : ''}</span>
          <kbd>⌘N</kbd>
        </button>
        <nav className="history">
          <div
            className="projects"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const paths = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean);
              if (paths.length) createProject(paths);
            }}
          >
            <div className="group-label row">
              Projects
              <button className="mini" title="New project from a folder" onClick={() => createProject(null)}>
                +
              </button>
            </div>
            {!projects.length && (
              <button className="hist hint-row" onClick={() => createProject(null)}>
                Attach a folder to start a project, or drop one here
              </button>
            )}
            {projects.map((p) => {
              const pChats = chats.filter((c) => c.projectId === p.id && hasMessages(c));
              const open = activeProjectId === p.id;
              return (
                <div key={p.id}>
                  <div className={`hist project ${projectPage === p.id ? 'active' : ''}`} onClick={() => setProjectPage(p.id)}>
                    <span className="folder-ico">{open ? '📂' : '📁'}</span>
                    <span className="hist-title">{p.name}</span>
                    {live.some((l) => pChats.some((c) => c.id === l.chatId)) && <span className="hist-live" />}
                  </div>
                  {open &&
                    pChats.slice(0, 6).map((c) => (
                      <div key={c.id} className={`hist nested ${!projectPage && c.id === chat.id ? 'active' : ''}`} onClick={() => showChat(c.id)}>
                        <span className="hist-title">{c.title}</span>
                        {live.some((l) => l.chatId === c.id) && <span className="hist-live" />}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
          {grouped.map(([g, cs]) => (
            <div key={g}>
              <div className="group-label">{g}</div>
              {cs.map((c) => (
                <div key={c.id} className={`hist ${!projectPage && c.id === chat.id ? 'active' : ''}`} onClick={() => showChat(c.id)}>
                  <span className="hist-title">{c.title}</span>
                  {live.some((l) => l.chatId === c.id) && <span className="hist-live" />}
                  <button className="hist-del" title="Delete chat" onClick={(e) => (e.stopPropagation(), confirm('Delete this chat?') && run(() => api.deleteChat(c.id)))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          ))}
        </nav>
        <UsageMini state={state} onClick={() => setSettingsOpen(true)} />
        <button className="side-btn" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
      </aside>

      <main>
        {openProject ? (
          <ProjectPage
            key={openProject.id}
            state={state}
            project={openProject}
            run={run}
            openChat={showChat}
            startChat={async (text) => {
              const c = await openChat(() => api.newChat('group', openProject.id));
              if (c) run(() => api.sendMessage(c.id, text));
            }}
            closed={() => setProjectPage('')}
          />
        ) : (
          <>
            <TopBar state={state} chat={chat} live={live} run={run} edit={setEditing} openProject={setProjectPage} />
            <Thread state={state} chat={chat} live={live} send={(t) => run(() => api.sendMessage(chat.id, t))} />
            <PauseBar state={state} run={run} />
            <Composer state={state} chat={chat} live={live} run={run} />
          </>
        )}
      </main>

      {editing && <AgentDialog state={state} agent={editing === 'new' ? null : editing} close={() => setEditing(null)} run={run} />}
      {settingsOpen && <SettingsDialog state={state} close={() => setSettingsOpen(false)} run={run} />}
      {toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ top bar: who you're talking to

function TopBar({ state, chat, live, run, edit, openProject }: { state: AppState; chat: Chat; live: LiveStatus[]; run: <T>(f: () => Promise<T>) => Promise<T | undefined>; edit: (a: Agent | 'new') => void; openProject: (id: string) => void }) {
  const project = state.projects.find((p) => p.id === chat.projectId);
  const lead = state.agents.find((a) => a.isLead);
  const target = chat.target === 'group' || !state.agents.some((a) => a.id === chat.target) ? 'group' : chat.target;
  const busy = (id: string) => live.some((l) => l.agentId === id);
  return (
    <header className="topbar drag">
      <div className="pills">
        <button className={`pill ${target === 'group' ? 'active' : ''}`} onClick={() => run(() => api.setChatTarget(chat.id, 'group'))} title={lead ? `Messages go to ${lead.name}, who brings in others as needed` : ''}>
          <span className="pill-emoji">👥</span> Group
        </button>
        {state.agents.map((a) => (
          <button
            key={a.id}
            className={`pill ${target === a.id ? 'active' : ''}`}
            onClick={() => (target === a.id ? edit(a) : run(() => api.setChatTarget(chat.id, a.id)))}
            onContextMenu={(e) => (e.preventDefault(), edit(a))}
            title={target === a.id ? `Edit ${a.name}` : `Talk to ${a.name} directly (right-click to edit)`}
          >
            <span className="pill-emoji">{a.emoji}</span> {a.name}
            {busy(a.id) && <span className="pill-live" />}
            {target === a.id && <span className="pill-edit">✎</span>}
          </button>
        ))}
        <button className="pill add" onClick={() => edit('new')} title="Add an agent">
          +
        </button>
      </div>
      <div className="spacer" />
      {project && (
        <button className="project-chip" onClick={() => openProject(project.id)} title={project.folders.join('\n')}>
          📁 {project.name}
        </button>
      )}
      {state.projects.length > 0 && (
        <select className="move-select" value={chat.projectId} onChange={(e) => run(() => api.moveChat(chat.id, e.target.value))} title="Move this chat to a project">
          {project ? <option value={project.id}>Move…</option> : <option value="">Add to project…</option>}
          {state.projects
            .filter((p) => p.id !== chat.projectId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {project ? `Move to ${p.name}` : p.name}
              </option>
            ))}
          {project && <option value="">Remove from project</option>}
        </select>
      )}
    </header>
  );
}

// ------------------------------------------------------------------ thread

function Thread({ state, chat, live, send, compact }: { state: AppState; chat: Chat; live: LiveStatus[]; send: (t: string) => void; compact?: boolean }) {
  const msgs = state.messages.filter((m) => m.chatId === chat.id);
  const working = live.filter((l) => l.chatId === chat.id);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length, working.length, working.map((w) => w.step).join()]);
  useEffect(() => {
    stick.current = true;
  }, [chat.id]);

  if (!msgs.length && compact) {
    const lead = state.agents.find((a) => a.isLead);
    return (
      <div className="thread quick-empty">
        <span className="muted">
          Ask {lead ? `${lead.name} and the team` : 'the team'} anything. <kbd>esc</kbd> to hide.
        </span>
      </div>
    );
  }
  if (!msgs.length) {
    const target = state.agents.find((a) => a.id === chat.target);
    const lead = state.agents.find((a) => a.isLead);
    return (
      <div className="thread empty-state">
        <div className="hello">
          <div className="hello-mark">◆</div>
          <h1>{target ? `Talk to ${target.name}` : 'What should the team work on?'}</h1>
          <p className="muted">
            {target
              ? target.persona
              : lead
                ? `${lead.name} answers and brings in ${state.agents.filter((a) => !a.isLead).map((a) => a.name).join(', ') || 'teammates'} when they'd help. @mention anyone to ask them directly.`
                : 'Add an agent with the + button to get started.'}
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="thread"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="column">
        {msgs.map((m, i) => (
          <MessageRow key={m.id} state={state} m={m} prev={msgs[i - 1]} />
        ))}
        {working.map((w) => {
          const a = state.agents.find((x) => x.id === w.agentId);
          return (
            <div key={w.agentId} className="msg agent working">
              <Avatar agent={a} />
              <div className="bubble-wrap">
                <div className="who" style={nameStyle(a)}>
                  {a?.name}
                </div>
                <div className="thinking">
                  <span className="dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {w.step || 'Thinking'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageRow({ state, m, prev }: { state: AppState; m: Message; prev?: Message }) {
  const html = useMemo(() => renderMarkdown(m.text, state.agents), [m.text, state.agents]);
  if (m.from === SYSTEM_ID && m.checkpoint) {
    const cp = m.checkpoint;
    return (
      <div className="note checkpoint">
        <span dangerouslySetInnerHTML={{ __html: html }} />
        {cp.files > 0 && (
          <button
            className="mini undo"
            onClick={() =>
              confirm(`Undo all changes to ${cp.files} file(s) in ${cp.folder} since this checkpoint? Running agents in this chat are stopped first.`) &&
              api.restoreCheckpoint(m.id).catch((e) => alert(errMsg(e)))
            }
          >
            ↩︎ Undo
          </button>
        )}
      </div>
    );
  }
  if (m.from === SYSTEM_ID) return <div className="note" dangerouslySetInnerHTML={{ __html: html }} />;
  if (m.from === USER_ID) {
    return (
      <div className="msg user">
        <div className="user-col">
          <div className="bubble" dangerouslySetInnerHTML={{ __html: html }} />
          {m.files?.length ? (
            <div className="attached">
              {m.files.map((f) => (
                <button key={f} className="file-chip" title={`${f}\nClick to show in Finder`} onClick={() => api.showInFinder(f.slice(0, f.lastIndexOf('/')) || '/')}>
                  📄 {f.split('/').pop()}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  const a = state.agents.find((x) => x.id === m.from);
  const cont = prev && prev.from === m.from;
  return (
    <div className={`msg agent ${cont ? 'cont' : ''}`}>
      {cont ? <div className="avatar-space" /> : <Avatar agent={a} />}
      <div className="bubble-wrap">
        {!cont && (
          <div className="who" style={nameStyle(a)}>
            {a?.name ?? 'Former agent'}
            <span className="time">{new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
        )}
        <div className="text" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer

function Composer({ state, chat, live, run, focusKey = 0 }: { state: AppState; chat: Chat; live: LiveStatus[]; run: <T>(f: () => Promise<T>) => Promise<T | undefined>; focusKey?: number }) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const target = state.agents.find((a) => a.id === chat.target);
  const lead = state.agents.find((a) => a.isLead);
  const busy = live.some((l) => l.chatId === chat.id) || state.inbox.some((i) => i.chatId === chat.id);

  useEffect(() => ta.current?.focus(), [chat.id, chat.target, focusKey]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(220, el.scrollHeight) + 'px';
  }, [text]);

  // @mention autocomplete for the word being typed: agents, then files in the chat's project.
  const m = /(^|\s)@"?([^\s"]*)$/.exec(text);
  const query = m ? m[2] : null;
  const [files, setFiles] = useState<{ label: string; insert: string }[]>([]);
  const inProject = Boolean(chat.projectId);
  useEffect(() => {
    if (query === null || !inProject) return setFiles([]);
    let live = true;
    const t = setTimeout(() => api.searchFiles(chat.id, query).then((r) => live && setFiles(r)), 80);
    return () => ((live = false), clearTimeout(t));
  }, [query, chat.id, inProject]);
  const agentOptions = query !== null && !/[./]/.test(query) ? state.agents.filter((a) => a.name.toLowerCase().startsWith(query.toLowerCase())) : [];
  const options: ({ kind: 'agent'; agent: Agent } | { kind: 'file'; label: string; insert: string })[] = [
    ...agentOptions.map((agent) => ({ kind: 'agent' as const, agent })),
    ...(query !== null ? files : []).map((f) => ({ kind: 'file' as const, ...f })),
  ];
  const complete = (o: (typeof options)[number]) => {
    const token = o.kind === 'agent' ? o.agent.name : o.insert;
    setText(text.replace(/@"?[^\s"]*$/, `@${token} `));
    setPick(0);
    ta.current?.focus();
  };
  const insertPaths = (paths: string[]) => {
    if (!paths.length) return;
    const tokens = paths.map((p) => (/\s/.test(p) ? `@"${p}"` : `@${p}`)).join(' ');
    setText((t) => (t && !/\s$/.test(t) ? t + ' ' : t) + tokens + ' ');
    ta.current?.focus();
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    run(() => api.sendMessage(chat.id, t));
  };

  return (
    <div className="composer-wrap">
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          insertPaths(Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean));
        }}
      >
        {options.length > 0 && (
          <div className="mention-menu">
            {options.map((o, i) =>
              o.kind === 'agent' ? (
                <button key={o.agent.id} className={i === pick ? 'active' : ''} onMouseDown={(e) => (e.preventDefault(), complete(o))}>
                  <Avatar agent={o.agent} size={22} /> <strong>{o.agent.name}</strong> <span className="muted">{o.agent.persona.slice(0, 60)}</span>
                </button>
              ) : (
                <button key={o.label} className={`file-opt ${i === pick ? 'active' : ''}`} onMouseDown={(e) => (e.preventDefault(), complete(o))}>
                  <span className="file-ico">📄</span> <span className="file-name">{o.label.split('/').pop()}</span>
                  <span className="muted">{o.label.includes('/') ? o.label.slice(0, o.label.lastIndexOf('/')) : ''}</span>
                </button>
              ),
            )}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={
            (target ? `Message ${target.name}` : lead ? `Message the group (${lead.name} leads)` : 'Add an agent to start') +
            (inProject ? '. Type @ for teammates or files' : '. @mention someone, or drop a file')
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (options.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                complete(options[Math.min(pick, options.length - 1)]);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy && !text.trim() ? (
          <button className="send stop" title="Stop" onClick={() => run(() => api.stopChat(chat.id))}>
            ■
          </button>
        ) : (
          <button className="send" title="Send" disabled={!text.trim()} onClick={send}>
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

function PauseBar({ state, run }: { state: AppState; run: <T>(f: () => Promise<T>) => Promise<T | undefined> }) {
  const s = state.settings;
  if (!s.paused) return null;
  const resets = state.usage.fiveHour?.resetsAt ? new Date(state.usage.fiveHour.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const why = {
    user: 'The team is paused.',
    daily_cap: `Paused: today's limit of ${s.dailyTurnCap} agent turns is used up.`,
    usage_limit: `Paused to protect your Claude usage limit${resets ? `. It resumes by itself after ${resets}` : ''}.`,
    '': 'The team is paused.',
  }[s.pauseReason];
  return (
    <div className="pausebar">
      <span>{why} Queued messages are kept.</span>
      <button onClick={() => run(() => api.updateSettings({ paused: false }))}>Resume now</button>
    </div>
  );
}

// ------------------------------------------------------------------ project page

const ACCESS: { value: ProjectReadAccess; label: string; help: string }[] = [
  { value: 'lead', label: 'Only the lead', help: 'The lead can open files; others ask the lead. Adds ~2.6k tokens to the lead\'s turns.' },
  { value: 'all', label: 'Everyone', help: 'Every agent can open files. Adds ~2.6k tokens to every agent turn in this project.' },
  { value: 'none', label: 'Nobody (lightest)', help: 'Agents only see the folder paths and the instructions below.' },
];

function ProjectPage(p: {
  state: AppState;
  project: Project;
  run: <T>(f: () => Promise<T>) => Promise<T | undefined>;
  openChat: (id: string) => void;
  startChat: (text: string) => void;
  closed: () => void;
}) {
  const { state, project, run } = p;
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const chats = state.chats
    .filter((c) => c.projectId === project.id && state.messages.some((m) => m.chatId === c.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const editors = state.agents.filter((a) => canEditFiles(a.capability));
  const setFolders = (folders: string[]) => run(() => api.updateProject(project.id, { folders }));
  const addFolders = async (paths?: string[]) => {
    const dirs = paths ?? (await api.chooseDirectories());
    if (dirs.length) setFolders([...project.folders, ...dirs]);
  };
  const start = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    p.startChat(t);
  };

  return (
    <div className="project-page">
      <header className="topbar drag">
        <span className="folder-big">📂</span>
        <input className="title-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() !== project.name && run(() => api.updateProject(project.id, { name }))} />
        <div className="spacer" />
        <button className="danger" onClick={() => confirm(`Delete "${project.name}" and its ${chats.length} chats? Your folders and files are not touched.`) && run(() => api.deleteProject(project.id)).then(p.closed)}>
          Delete project
        </button>
      </header>
      <div className="project-scroll">
        <div className="column">
          <div className="composer start">
            <textarea
              rows={2}
              value={text}
              placeholder={`Start a chat in ${project.name}…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  start();
                }
              }}
            />
            <button className="send" disabled={!text.trim()} onClick={start}>
              ↑
            </button>
          </div>

          <section
            className={`card ${dragging ? 'drop' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFolders(Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean));
            }}
          >
            <div className="card-head">
              <h4>Folders</h4>
              <button onClick={() => addFolders()}>+ Add folder</button>
            </div>
            {!project.folders.length && <div className="muted small">No folders yet. Add one or drop it here.</div>}
            {project.folders.map((f, i) => (
              <div key={f} className="folder-row">
                <span>📁</span>
                <span className="path" title={f}>
                  {f}
                </span>
                {i === 0 && <span className="tag">working folder</span>}
                <button className="mini" onClick={() => run(() => api.showInFinder(f))}>
                  Show
                </button>
                <button className="mini" title="Detach (files are not deleted)" onClick={() => setFolders(project.folders.filter((x) => x !== f))}>
                  ×
                </button>
              </div>
            ))}
            <div className="field-row">
              <label>
                Who can open files
                <select value={project.readAccess} onChange={(e) => run(() => api.updateProject(project.id, { readAccess: e.target.value as ProjectReadAccess }))}>
                  {ACCESS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="muted small">
                {ACCESS.find((a) => a.value === project.readAccess)?.help}
                {editors.length > 0 && ` ${editors.map((a) => a.name).join(', ')} can also edit files (their "Can use" setting).`}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h4>Instructions</h4>
              {instructions !== project.instructions && (
                <button className="primary" onClick={() => run(() => api.updateProject(project.id, { instructions }))}>
                  Save
                </button>
              )}
            </div>
            <textarea
              rows={5}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => instructions !== project.instructions && run(() => api.updateProject(project.id, { instructions }))}
              placeholder="What is this project? Goals, conventions, tone, key files to look at… Every agent reads this in this project's chats, so keep it short."
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h4>Chats</h4>
            </div>
            {!chats.length && <div className="muted small">No chats yet. Start one above.</div>}
            {chats.map((c) => (
              <button key={c.id} className="chat-row" onClick={() => p.openChat(c.id)}>
                <span>{c.title}</span>
                <span className="muted small">{new Date(c.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
              </button>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ usage

function pct(x?: number) {
  return Math.round((x ?? 0) * 100);
}

function UsageMini({ state, onClick }: { state: AppState; onClick: () => void }) {
  const u = state.usage;
  const five = pct(u.fiveHour?.utilization);
  return (
    <button className="usage-mini" onClick={onClick} title="Claude usage">
      <div className="usage-row">
        <span>5-hour usage</span>
        <span>{u.fiveHour ? `${five}%` : '-'}</span>
      </div>
      <div className="bar">
        <div style={{ width: `${Math.min(100, five)}%` }} className={five >= 80 ? 'hot' : ''} />
      </div>
      <div className="usage-row muted">
        <span>
          {u.turnsToday}
          {state.settings.dailyTurnCap ? ` / ${state.settings.dailyTurnCap}` : ''} turns today
        </span>
        {state.settings.leanMode && <span className="lean">lean</span>}
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ dialogs

function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <header>
          <h3>{title}</h3>
          <button className="x" onClick={close}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function AgentDialog({ state, agent, close, run }: { state: AppState; agent: Agent | null; close: () => void; run: <T>(f: () => Promise<T>) => Promise<T | undefined> }) {
  const [d, setD] = useState<AgentDraft>(
    agent
      ? { name: agent.name, emoji: agent.emoji, hue: agent.hue, persona: agent.persona, model: agent.model, capability: agent.capability, isLead: agent.isLead }
      : { ...PRESETS[0].draft, name: state.agents.some((a) => a.name === PRESETS[0].draft.name) ? '' : PRESETS[0].draft.name },
  );
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setD({ ...d, [k]: v });
  const save = async () => {
    const ok = await run(() => (agent ? api.updateAgent(agent.id, d) : api.addAgent(d)).then(() => true));
    if (ok) close();
  };
  return (
    <Modal title={agent ? `Edit ${agent.name}` : 'Add an agent'} close={close}>
      <div className="form">
        {!agent && (
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.label} className={d.persona === p.draft.persona && d.emoji === p.draft.emoji ? 'active' : ''} onClick={() => setD({ ...p.draft, name: state.agents.some((a) => a.name === p.draft.name) ? '' : p.draft.name })}>
                {p.draft.emoji} {p.label}
              </button>
            ))}
          </div>
        )}
        <div className="name-row">
          <div className="emoji-pick">
            <Avatar agent={{ ...(agent ?? ({} as Agent)), ...d } as Agent} size={52} />
            <div className="emoji-grid">
              {EMOJIS.map((e) => (
                <button key={e} className={d.emoji === e ? 'active' : ''} onClick={() => set('emoji', e)}>
                  {e}
                </button>
              ))}
              <input type="range" min={0} max={359} value={d.hue} onChange={(e) => set('hue', Number(e.target.value))} title="Colour" />
            </div>
          </div>
          <label className="grow">
            Name
            <input value={d.name} onChange={(e) => set('name', e.target.value.replace(/\s/g, ''))} placeholder="One word, e.g. Scout" autoFocus />
          </label>
        </div>
        <label>
          Who are they?
          <textarea rows={4} value={d.persona} onChange={(e) => set('persona', e.target.value)} placeholder="Role, personality, what they're good at, how they should answer…" />
        </label>
        <div className="row2">
          <label>
            Model
            <select value={d.model} onChange={(e) => set('model', e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Can use
            <select value={d.capability} onChange={(e) => set('capability', e.target.value as Capability)}>
              {CAPABILITIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={d.isLead} onChange={(e) => set('isLead', e.target.checked)} />
          Group lead: answers messages sent to the group and brings in others
        </label>
      </div>
      <div className="actions">
        {agent && (
          <button className="danger" onClick={() => confirm(`Remove ${agent.name}?`) && run(() => api.removeAgent(agent.id)).then(close)}>
            Remove
          </button>
        )}
        <div className="spacer" />
        <button onClick={close}>Cancel</button>
        <button className="primary" disabled={!d.name.trim()} onClick={save}>
          {agent ? 'Save' : 'Add to team'}
        </button>
      </div>
    </Modal>
  );
}

const SHORTCUTS = ['Alt+Space', 'CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'Control+Space'];

function prettyShortcut(a: string): string {
  return a.replace('CommandOrControl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace('Control', '⌃').replace(/\+/g, ' ');
}

function ShortcutSetting({ value, save }: { value: string; save: (v: string) => void }) {
  const [status, setStatus] = useState<{ ok: boolean } | null>(null);
  useEffect(() => {
    api.shortcutStatus().then(setStatus);
  }, [value]);
  return (
    <label>
      Quick chat shortcut
      <select value={SHORTCUTS.includes(value) ? value : ''} onChange={(e) => save(e.target.value)}>
        {SHORTCUTS.map((a) => (
          <option key={a} value={a}>
            {prettyShortcut(a)}
          </option>
        ))}
        <option value="">Off (use the ◆ menu-bar icon)</option>
      </select>
      <small>{value && status && !status.ok ? `${prettyShortcut(value)} is taken by another app. Pick a different one.` : 'Opens a small chat box over any app, like Spotlight.'}</small>
    </label>
  );
}

function SettingsDialog({ state, close, run }: { state: AppState; close: () => void; run: <T>(f: () => Promise<T>) => Promise<T | undefined> }) {
  const s = state.settings;
  const u = state.usage;
  const [check, setCheck] = useState<{ ok: boolean; path: string; version: string; error?: string } | null>(null);
  const [claudePath, setClaudePath] = useState(s.claudePath);
  useEffect(() => {
    api.checkClaude().then(setCheck);
  }, [s.claudePath]);
  const upd = (p: Partial<typeof s>) => run(() => api.updateSettings(p));
  const reset = (w?: { resetsAt: number }) => (w?.resetsAt ? ` · resets ${new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '');
  return (
    <Modal title="Settings" close={close}>
      <div className="form">
        <div className={`banner ${check?.ok ? 'ok' : check ? 'error' : ''}`}>
          {!check ? (
            'Checking for Claude Code…'
          ) : check.ok ? (
            <>
              Connected to <strong>Claude Code {check.version.split(' ')[0]}</strong>. Agents use whichever account it's logged into (run <code>claude</code> then <code>/login</code> in Terminal to pick your Pro/Max plan).
            </>
          ) : (
            <>
              <strong>Claude Code not found.</strong> {check.error} Install with <code>curl -fsSL https://claude.ai/install.sh | bash</code>, then run <code>claude</code> once and log in.
            </>
          )}
        </div>

        <h4>Usage</h4>
        <div className="usage-big">
          <div>
            <div className="usage-row">
              <span>5-hour window</span>
              <span>
                {u.fiveHour ? `${pct(u.fiveHour.utilization)}%` : 'not reported yet'}
                {reset(u.fiveHour)}
              </span>
            </div>
            <div className="bar">
              <div style={{ width: `${pct(u.fiveHour?.utilization)}%` }} />
            </div>
          </div>
          <div>
            <div className="usage-row">
              <span>Weekly</span>
              <span>
                {u.sevenDay ? `${pct(u.sevenDay.utilization)}%` : 'not reported yet'}
                {reset(u.sevenDay)}
              </span>
            </div>
            <div className="bar">
              <div style={{ width: `${pct(u.sevenDay?.utilization)}%` }} />
            </div>
          </div>
        </div>

        <h4>Saving usage</h4>
        <label className="check">
          <input type="checkbox" checked={s.leanMode} onChange={(e) => upd({ leanMode: e.target.checked })} />
          <span>
            <strong>Lean mode</strong>: short system prompt, no skills, settings files or MCP servers. About 4× fewer tokens per turn. Applies to new chats.
          </span>
        </label>
        <div className="row3">
          <label>
            Pause at 5-hour usage
            <select value={s.usagePauseAt} onChange={(e) => upd({ usagePauseAt: Number(e.target.value) })}>
              <option value={0}>Never</option>
              <option value={0.5}>50%</option>
              <option value={0.7}>70%</option>
              <option value={0.8}>80%</option>
              <option value={0.9}>90%</option>
            </select>
          </label>
          <label>
            Turns per day
            <input type="number" min={0} value={s.dailyTurnCap} onChange={(e) => upd({ dailyTurnCap: Number(e.target.value) })} />
            <small>0 = no limit</small>
          </label>
          <label>
            Agent-to-agent hops
            <input type="number" min={1} max={30} value={s.maxDepth} onChange={(e) => upd({ maxDepth: Number(e.target.value) })} />
            <small>per message from you</small>
          </label>
        </div>
        <div className="row3">
          <label>
            Agents at once
            <input type="number" min={1} max={6} value={s.maxConcurrent} onChange={(e) => upd({ maxConcurrent: Number(e.target.value) })} />
          </label>
        </div>

        <label className="check">
          <input type="checkbox" checked={s.checkpoints} onChange={(e) => upd({ checkpoints: e.target.checked })} />
          <span>Save a git checkpoint before agents edit a project, so you can undo their changes in one click</span>
        </label>

        <h4>Menu bar</h4>
        <ShortcutSetting value={s.quickShortcut} save={(v) => upd({ quickShortcut: v })} />
        <label className="check">
          <input type="checkbox" checked={s.notifications} onChange={(e) => upd({ notifications: e.target.checked })} />
          <span>Notify me when an agent replies while Troupe is in the background</span>
        </label>

        <h4>Setup</h4>
        <label className="check">
          <input type="checkbox" checked={s.forceSubscription} onChange={(e) => upd({ forceSubscription: e.target.checked })} />
          <span>
            Always use my Claude subscription (ignore <code>ANTHROPIC_API_KEY</code>)
          </span>
        </label>
        <label>
          Workspace folder <small>(where agents with file access work)</small>
          <div className="inline">
            <input value={s.workspaceDir} readOnly />
            <button
              onClick={async () => {
                const d = await api.chooseDirectory();
                if (d) upd({ workspaceDir: d });
              }}
            >
              Choose…
            </button>
          </div>
        </label>
        <label>
          Claude CLI path <small>(empty = auto-detect{check?.path ? `: ${check.path}` : ''})</small>
          <div className="inline">
            <input value={claudePath} onChange={(e) => setClaudePath(e.target.value)} />
            <button onClick={() => upd({ claudePath: claudePath.trim() })}>Save</button>
          </div>
        </label>
      </div>
      <div className="actions">
        <button onClick={() => upd({ paused: !s.paused })}>{s.paused ? '▶ Resume team' : '❚❚ Pause team'}</button>
        <div className="spacer" />
        <button className="primary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ menu-bar quick chat

/** A quick chat is reused if you come back to it within this long. */
const QUICK_REUSE_MS = 3 * 60 * 60 * 1000;

function QuickApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [live, setLive] = useState<LiveStatus[]>([]);
  const [chatId, setChatId] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [toast, setToast] = useState('');
  const stateRef = useRef<AppState | null>(null);
  stateRef.current = state;

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      setToast(errMsg(e));
    }
  };

  /** The latest recent quick chat, or a fresh one. */
  const pickChat = async (force = '') => {
    if (force) return setChatId(force);
    const s = stateRef.current ?? (await api.getState());
    const recent = s.chats.filter((c) => c.quick && Date.now() - c.updatedAt < QUICK_REUSE_MS).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const c = recent ?? (await run(() => api.newChat('group', '', true)));
    if (!c) return;
    setState(await api.getState());
    setChatId(c.id);
  };
  const fresh = async () => {
    const c = await run(() => api.newChat('group', '', true));
    if (!c) return;
    setState(await api.getState());
    setChatId(c.id);
    setFocusKey((k) => k + 1);
  };

  useEffect(() => {
    api.getState().then((s) => {
      setState(s);
      stateRef.current = s;
      pickChat();
    });
    api.getLive().then(setLive);
    const a = api.onState(setState);
    const b = api.onLive(setLive);
    const c = api.onQuickShown((id) => {
      pickChat(id);
      setFocusKey((k) => k + 1);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.mention-menu')) api.hideQuick();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        fresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => (a(), b(), c(), window.removeEventListener('keydown', onKey));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const chat = state?.chats.find((c) => c.id === chatId);
  if (!state || !chat) return <div className="quick loading">◆</div>;
  const hasMessages = state.messages.some((m) => m.chatId === chat.id);
  return (
    <div className={`quick ${hasMessages ? '' : 'fresh'}`}>
      <header className="quick-head drag">
        <span className="logo">◆</span>
        <select className="quick-target" value={chat.target} onChange={(e) => run(() => api.setChatTarget(chat.id, e.target.value))}>
          <option value="group">👥 Group</option>
          {state.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="mini" title="New quick chat (⌘N)" onClick={fresh}>
          ✎ New
        </button>
        <button className="mini" title="Open this chat in the Troupe window" onClick={() => api.openInMain(chat.id)}>
          ↗ Open
        </button>
      </header>
      <Thread state={state} chat={chat} live={live} send={(t) => run(() => api.sendMessage(chat.id, t))} compact />
      <PauseBar state={state} run={run} />
      <Composer state={state} chat={chat} live={live} run={run} focusKey={focusKey} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const isQuick = new URLSearchParams(location.search).get('mode') === 'quick';
document.body.classList.toggle('quick-mode', isQuick);
createRoot(document.getElementById('root')!).render(isQuick ? <QuickApp /> : <App />);
