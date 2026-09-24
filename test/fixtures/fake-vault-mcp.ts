// A tiny stdio MCP server standing in for the Obsidian vault. Test fixture.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const notes: Record<string, string> = { 'Projects/alfred.md': '# Alfred\nThe agent platform.', 'Independent/secret.md': 'TOP SECRET' };
const calls: string[] = [];

const s = new McpServer({ name: 'fake-vault', version: '1.0.0' });
s.tool('read_note', 'Read a note', { path: z.string() }, async ({ path }) => {
  calls.push(`read:${path}`);
  const body = notes[path];
  return body === undefined
    ? { isError: true, content: [{ type: 'text', text: `no such note ${path}` }] }
    : { content: [{ type: 'text', text: body }] };
});
s.tool('search_notes', 'Search notes', { query: z.string() }, async ({ query }) => ({
  content: [{ type: 'text', text: Object.keys(notes).filter(k => notes[k].includes(query)).join('\n') }],
}));
s.tool('write_note', 'Write a note', { path: z.string(), body: z.string() }, async ({ path, body }) => {
  notes[path] = body;
  return { content: [{ type: 'text', text: 'written' }] };
});
s.tool('calls', 'Which paths were requested (test hook)', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify(calls) }] }));
await s.connect(new StdioServerTransport());
