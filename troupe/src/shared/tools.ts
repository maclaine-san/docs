// The tools every agent gets through Troupe's MCP server ("mcp__troupe__*").

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TROUPE_TOOLS: ToolDef[] = [
  {
    name: 'send_message',
    description:
      'Send a message to a teammate (by name), a channel ("#name") or the human ("user"). The recipient is woken up to read it. In a channel, only @mentioned teammates are woken (use @all for everyone).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Teammate name, "#channel" or "user".' },
        text: { type: 'string', description: 'Message body (markdown).' },
        task_id: { type: 'string', description: 'Optional task id this message is about, e.g. "T-4".' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a task and assign it to a teammate (or yourself). The assignee is notified and woken up.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'What done looks like, context, constraints.' },
        assignee: { type: 'string', description: 'Teammate name. Defaults to yourself.' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'update_task',
    description:
      'Update a task you own or created: change status and/or record a result. Marking a task done notifies whoever created it.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
        result: { type: 'string', description: 'Deliverable, summary, or reason for being blocked.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks on the team board.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['mine', 'created_by_me', 'all'], description: 'Default "mine".' },
        include_done: { type: 'boolean', description: 'Default false.' },
      },
    },
  },
  {
    name: 'list_team',
    description: 'List everyone on the team with their role, responsibilities, manager and whether they are busy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_channel',
    description: 'Read recent messages from a channel you are in ("#name"), or your DM with a teammate/user (their name or "user").',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
      },
      required: ['channel'],
    },
  },
];
