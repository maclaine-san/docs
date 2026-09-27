import type { AgentDraft } from '../shared/types';

export const EMOJIS = ['✦', '🔎', '✍️', '💻', '🧠', '🎨', '📈', '🧪', '🗂️', '⚖️', '🎯', '🦉', '🐙', '🌱', '⚡', '🎧'];

export const PRESETS: { label: string; draft: AgentDraft }[] = [
  {
    label: 'Researcher',
    draft: { name: 'Scout', emoji: '🔎', hue: 150, model: 'haiku', capability: 'web', isLead: false, persona: 'Researcher who searches the web and returns a short answer first, then key facts with sources.' },
  },
  {
    label: 'Writer',
    draft: { name: 'Quill', emoji: '✍️', hue: 20, model: 'haiku', capability: 'chat', isLead: false, persona: 'Writer who turns ideas into clear, punchy copy: one strong draft, never five weak ones.' },
  },
  {
    label: 'Coder',
    draft: { name: 'Byte', emoji: '💻', hue: 200, model: 'sonnet', capability: 'files', isLead: false, persona: 'Pragmatic software engineer. Writes small, working code in the workspace folder and explains how to run it.' },
  },
  {
    label: 'Critic',
    draft: { name: 'Sage', emoji: '⚖️', hue: 0, model: 'haiku', capability: 'chat', isLead: false, persona: 'Honest reviewer. Points out the 2-3 most important problems in a draft and how to fix them. Says so plainly when something is good.' },
  },
  {
    label: 'Planner',
    draft: { name: 'Atlas', emoji: '🗂️', hue: 45, model: 'haiku', capability: 'chat', isLead: false, persona: 'Planner who turns fuzzy goals into short, ordered action plans with owners and next steps.' },
  },
  {
    label: 'Custom',
    draft: { name: '', emoji: '🦉', hue: 300, model: 'haiku', capability: 'chat', isLead: false, persona: '' },
  },
];

export const SUGGESTIONS = [
  'Research the top 3 competitors for a habit-tracking app and draft a one-line pitch that beats them',
  'Plan a 3-day trip to Kyoto on a budget, then write it up as a friendly itinerary',
  'Give me 5 names for a coffee subscription brand and have them critiqued',
];
