import type { AgentDraft } from '../shared/types';

export interface Template {
  key: string;
  label: string;
  blurb: string;
  draft: Omit<AgentDraft, 'name' | 'reportsTo' | 'cwd'>;
}

const base = { instructions: '', useMyMcpServers: false, heartbeatMinutes: 0 };

export const TEMPLATES: Template[] = [
  {
    key: 'lead',
    label: 'Chief of Staff',
    blurb: 'Turns your goals into plans and runs the team.',
    draft: {
      ...base,
      role: 'Chief of Staff',
      model: 'opus',
      tools: 'chat',
      responsibilities:
        'Own the goals the user gives you. Break them into concrete tasks, delegate each to the teammate who owns that area, track progress on the task board, unblock people, and send the user a concise summary when a goal is done or needs a decision. Do not do specialist work yourself when a teammate owns it.',
    },
  },
  {
    key: 'pm',
    label: 'Product Manager',
    blurb: 'Specs, priorities, acceptance criteria.',
    draft: {
      ...base,
      role: 'Product Manager',
      model: 'sonnet',
      tools: 'research',
      responsibilities:
        'Turn ideas into clear specs with user stories and acceptance criteria. Prioritise ruthlessly. Hand build work to engineering and review what comes back against the spec.',
    },
  },
  {
    key: 'eng',
    label: 'Engineer',
    blurb: 'Writes and edits code in the workspace.',
    draft: {
      ...base,
      role: 'Software Engineer',
      model: 'sonnet',
      tools: 'builder',
      responsibilities:
        'Implement features and fixes in the shared workspace. Keep changes small and tested. Report what you changed, where, and how to run it. Ask the PM when requirements are unclear.',
    },
  },
  {
    key: 'research',
    label: 'Researcher',
    blurb: 'Searches the web and reads files.',
    draft: {
      ...base,
      role: 'Research Analyst',
      model: 'sonnet',
      tools: 'research',
      responsibilities:
        'Research questions from the team using the web and files in the workspace. Deliver a short answer first, then evidence with sources. Flag uncertainty honestly.',
    },
  },
  {
    key: 'writer',
    label: 'Writer',
    blurb: 'Copy, docs, posts, emails.',
    draft: {
      ...base,
      role: 'Content Writer',
      model: 'sonnet',
      tools: 'chat',
      responsibilities: 'Write clear, on-brand copy: landing pages, docs, social posts, emails. Offer one strong draft, not five weak ones.',
    },
  },
  {
    key: 'qa',
    label: 'Reviewer',
    blurb: 'Critiques work before it ships.',
    draft: {
      ...base,
      role: 'QA Reviewer',
      model: 'sonnet',
      tools: 'research',
      responsibilities:
        'Review deliverables from teammates for correctness, quality and fit to the request. Be specific: list the problems in priority order and what would fix them. Approve explicitly when good.',
    },
  },
  {
    key: 'custom',
    label: 'Custom',
    blurb: 'Start from a blank profile.',
    draft: { ...base, role: '', model: '', tools: 'chat', responsibilities: '' },
  },
];
