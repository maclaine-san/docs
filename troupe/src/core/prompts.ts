import type { Agent, AppState, Message, Project } from '../shared/types';
import { USER_ID, SYSTEM_ID, canEditFiles } from '../shared/types';
import { formatFile, type FileContent } from './files';
import { CODE_COMMANDS } from './claudeRunner';

/** Max earlier chat messages shown to an agent per turn, and max characters each. */
const CONTEXT_MESSAGES = 12;
const CONTEXT_CHARS = 1500;
const INSTRUCTIONS_CHARS = 3000;

function firstLine(s: string, n = 90): string {
  const line = s.trim().split('\n')[0];
  return line.length > n ? line.slice(0, n) + '…' : line;
}

export function roster(state: AppState, self: Agent): string {
  const others = state.agents.filter((a) => a.id !== self.id);
  if (!others.length) return '(none: it is just you and the user)';
  return others.map((a) => `- @${a.name}${a.isLead ? ' (lead)' : ''}: ${firstLine(a.persona) || 'no description'}`).join('\n');
}

export interface ProjectContext {
  project: Project;
  /** This agent can open files in the project's folders. */
  canRead: boolean;
  /** This agent can also create and edit files there. */
  canEdit: boolean;
}

export function projectBrief(ctx: ProjectContext): string {
  const { project, canRead, canEdit } = ctx;
  const lines = [`Project: ${project.name}`];
  if (project.folders.length) {
    lines.push(`Project folders: ${project.folders.join(', ')}`);
    lines.push(
      canEdit
        ? 'You can read and edit files there. Look only at what the task needs (use Glob/Grep before Read); do not read whole trees.'
        : canRead
          ? 'You can read files there (read-only). Look only at what the question needs (use Glob/Grep before Read); do not read whole trees.'
          : 'You cannot open these files. If you need their contents, @mention a teammate who can, or ask the user.',
    );
  }
  const ins = project.instructions.trim();
  if (ins) lines.push(`Project instructions:\n${ins.length > INSTRUCTIONS_CHARS ? ins.slice(0, INSTRUCTIONS_CHARS) + ' […]' : ins}`);
  return lines.join('\n');
}

/** Kept short on purpose: in lean mode this replaces Claude Code's whole system prompt. */
export function systemPrompt(state: AppState, agent: Agent, workdir: string, project?: ProjectContext): string {
  const lines = [
    `You are ${agent.name}. ${agent.persona.trim()}`,
    '',
    'You are in Troupe, a group chat between the user and a few AI teammates:',
    roster(state, agent),
    '',
    'How to behave:',
    '- Your reply is posted to the chat as-is (markdown is fine). Be concise and direct.',
    '- To hand work to a teammate, start a line with @Name and a specific request, e.g. "@Leo draft a tagline for X". Several at once: one line each. They answer in the chat and you are woken up once with all their answers.',
    '- Only a line that starts with @Name notifies anyone. Elsewhere, refer to teammates by plain name. Never hand off just to thank, acknowledge or say hello.',
    '- If the request is unclear, ask the user yourself instead of bringing in teammates.',
    '- When a teammate asks you something, answer it; don\'t @mention them back unless you need more from them.',
  ];
  if (agent.isLead) {
    lines.push(
      '- You are the lead. When the user writes to the group, answer yourself if you can. Bring teammates in only when their skills clearly help, and ask everyone you need in one message. When their answers arrive, give the user one combined final answer.',
    );
  }
  if (agent.capability === 'code') {
    lines.push(`- Shell commands you can run: ${CODE_COMMANDS.join(', ')}. Anything else (rm, mv, curl, redirects, chained commands) is blocked. Use the Edit/Write tools to change files.`);
  }
  if (project) lines.push('', projectBrief(project));
  else if (canEditFiles(agent.capability)) lines.push(`- Your working folder is ${workdir}. Save substantial deliverables there as files.`);
  return lines.join('\n');
}

function speaker(state: AppState, id: string): string {
  if (id === USER_ID) return 'User';
  if (id === SYSTEM_ID) return 'Troupe';
  return state.agents.find((a) => a.id === id)?.name ?? 'Former teammate';
}

function clip(s: string): string {
  return s.length > CONTEXT_CHARS ? s.slice(0, CONTEXT_CHARS) + ' […]' : s;
}

/**
 * The wake-up prompt: chat messages the agent hasn't seen yet (capped), and
 * who is waiting for it. The session already remembers everything before that.
 */
export function turnPrompt(
  state: AppState,
  agent: Agent,
  unseen: Message[],
  addressedBy: string[],
  teamChanged: boolean,
  projectUpdate?: ProjectContext,
  files?: Map<string, FileContent[]>,
): string {
  const parts: string[] = [];
  if (projectUpdate) parts.push(`(Project update:\n${projectBrief(projectUpdate)})`);
  if (teamChanged) parts.push(`(Team update. You are ${agent.name}${agent.isLead ? ', the lead' : ''}: ${agent.persona}\nYour teammates are now:\n${roster(state, agent)})`);
  const others = unseen.filter((m) => m.from !== agent.id && !m.checkpoint);
  const shown = others.slice(-CONTEXT_MESSAGES);
  const skipped = others.length - shown.length;
  if (skipped > 0) parts.push(`(${skipped} earlier messages omitted)`);
  for (const m of shown) {
    const attached = files?.get(m.id);
    parts.push(`${speaker(state, m.from)}: ${clip(m.text)}${attached?.length ? '\n\n' + attached.map(formatFile).join('\n\n') : ''}`);
  }
  const who = [...new Set(addressedBy.map((id) => speaker(state, id)))];
  parts.push(`---\n${who.length ? `${who.join(' and ')} ${who.length > 1 ? 'are' : 'is'} waiting for your reply.` : 'Reply if you have something useful to add.'}`);
  return parts.join('\n\n');
}

/**
 * Agents an agent hands work to: @Name at the start of a line (optionally a
 * list like "@Scout @Quill, …" or after a bullet). Mid-sentence mentions such
 * as "@CTO's fix" don't count, so agents can refer to each other freely.
 */
export function handOffs(state: AppState, text: string, exclude = ''): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const lead = /^\s*(?:[-*•>]|\d+[.)])?\s*\**((?:@[A-Za-z][\w-]*\**(?:\s*(?:,|&|and)\s*|\s+)?)+)/.exec(line);
    if (!lead) continue;
    for (const m of lead[1].matchAll(/@([A-Za-z][\w-]*)/g)) names.push(m[1]);
  }
  return mentionedAgents(state, names.map((n) => `@${n}`).join(' '), exclude);
}

/** Agent ids @mentioned in `text` (by name, case-insensitive), excluding `exclude`. */
export function mentionedAgents(state: AppState, text: string, exclude = ''): string[] {
  const names = [...text.matchAll(/@([A-Za-z][A-Za-z0-9_-]*)(?!['’]s\b)/g)].map((m) => m[1].toLowerCase());
  const ids = names
    .map((n) => state.agents.find((a) => a.name.toLowerCase() === n)?.id)
    .filter((id): id is string => Boolean(id) && id !== exclude);
  return [...new Set(ids)];
}
