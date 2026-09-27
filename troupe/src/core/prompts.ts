import type { Agent, AppState, Message, Task } from '../shared/types';
import { USER_ID, SYSTEM_ID } from '../shared/types';

export function displayName(state: AppState, id: string): string {
  if (id === USER_ID) return 'user (your human boss)';
  if (id === SYSTEM_ID) return 'Troupe';
  const a = state.agents.find((x) => x.id === id);
  return a ? `${a.name} (${a.role})` : 'a former teammate';
}

export function systemPrompt(agent: Agent, workdir: string): string {
  return `You are ${agent.name}, the ${agent.role} on a team of AI agents that work together inside Troupe. The team is run by a human, called "the user", who hired you.

# Your responsibilities
${agent.responsibilities.trim() || '(none written yet: ask your manager what you own)'}

# How Troupe works
- You wake up when someone messages you, assigns you a task, or on a scheduled heartbeat. Each wake-up lists what is new since your last turn, your open tasks and the current team.
- You talk to teammates only through the troupe tools:
  - send_message(to, text): "to" is a teammate's name, a "#channel", or "user".
  - create_task(title, description, assignee): delegate work to the teammate who owns that area. The assignee is notified.
  - update_task(task_id, status, result): move your tasks to in_progress, blocked or done. Put the deliverable or a summary in result when done; whoever created the task is notified.
  - list_tasks, list_team, read_channel: look things up.
- Your plain-text reply at the end of a turn is delivered to the user only if the user messaged you in this wake-up. Otherwise it goes to your private work log and nobody else sees it. To answer a teammate, use send_message.
- Every message wakes its recipient and uses the team's shared usage limit. Don't send acknowledgements, thanks or status pings that need no reply. Batch what you have to say into one message.
- When you finish work someone asked for, report back once, with the result.
- Stay in your lane. If something belongs to a teammate, delegate or hand it off to them. When blocked, escalate to your manager (see "reports to" in the roster) or the user.
- The team's shared working directory is ${workdir}. Save substantial deliverables there as files and mention the path.
${agent.instructions.trim() ? `\n# Additional instructions\n${agent.instructions.trim()}\n` : ''}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function roster(state: AppState, self: Agent): string {
  const lines = state.agents.map((a) => {
    const mgr = a.reportsTo ? state.agents.find((m) => m.id === a.reportsTo)?.name ?? 'user' : 'user';
    const me = a.id === self.id ? ' ← you' : '';
    return `- ${a.name}: ${a.role}; reports to ${mgr}${a.paused ? '; paused' : ''}${me}`;
  });
  const channels = state.channels
    .filter((c) => c.kind === 'channel' && c.members.includes(self.id))
    .map((c) => `#${c.name}`);
  return `${lines.join('\n')}\nYour channels: ${channels.length ? channels.join(', ') : '(none)'}`;
}

function openTasks(state: AppState, self: Agent): Task[] {
  return state.tasks.filter((t) => t.assigneeId === self.id && t.status !== 'done');
}

export function formatTaskLine(state: AppState, t: Task): string {
  const who = state.agents.find((a) => a.id === t.assigneeId)?.name ?? 'unassigned';
  const from = t.createdBy === USER_ID ? 'user' : state.agents.find((a) => a.id === t.createdBy)?.name ?? 'unknown';
  return `${t.id} [${t.status}] ${t.title} (assignee: ${who}, from: ${from})`;
}

export function channelLabel(state: AppState, channelId: string, viewer: string): string {
  const c = state.channels.find((x) => x.id === channelId);
  if (!c) return '(deleted channel)';
  if (c.kind === 'channel') return `#${c.name}`;
  const name = (id: string) => (id === USER_ID ? 'user' : state.agents.find((a) => a.id === id)?.name ?? '?');
  if (!c.members.includes(viewer)) return `DM ${c.members.map(name).join(' ↔ ')}`;
  const other = c.members.find((m) => m !== viewer) ?? viewer;
  return `DM with ${name(other)}`;
}

export type WakeReason = 'messages' | 'heartbeat';

export function turnPrompt(state: AppState, agent: Agent, messages: Message[], reason: WakeReason): string {
  const parts: string[] = [];
  parts.push(`<troupe_wakeup reason="${reason}" time="${formatTime(Date.now())}">`);
  if (agent.sessionStarted && agent.briefedProfileVersion !== agent.profileVersion) {
    parts.push(
      `Your profile was updated by the user. From now on:\nRole: ${agent.role}\nResponsibilities:\n${agent.responsibilities}` +
        (agent.instructions.trim() ? `\nAdditional instructions:\n${agent.instructions}` : ''),
    );
  }
  parts.push(`## Team\n${roster(state, agent)}`);
  if (messages.length) {
    parts.push(
      '## New messages\n' +
        messages
          .map((m) => {
            const where = channelLabel(state, m.channelId, agent.id);
            const task = m.taskId ? ` [re ${m.taskId}]` : '';
            return `[${where}] ${displayName(state, m.from)}${task} at ${formatTime(m.ts)}:\n${m.text}`;
          })
          .join('\n\n'),
    );
  } else if (reason === 'heartbeat') {
    parts.push('## Heartbeat\nNo new messages. Review your open tasks and move them forward. If there is nothing useful to do, reply "nothing to do" and stop.');
  }
  const tasks = openTasks(state, agent);
  parts.push(`## Your open tasks\n${tasks.length ? tasks.map((t) => '- ' + formatTaskLine(state, t)).join('\n') : '(none)'}`);
  const fromUser = messages.some((m) => m.from === USER_ID);
  parts.push(
    fromUser
      ? 'The user is waiting for your reply: your final text reply will be posted back to them.'
      : 'Your final text reply is private (work log). Use send_message / update_task to communicate.',
  );
  parts.push('</troupe_wakeup>');
  return parts.join('\n\n');
}
