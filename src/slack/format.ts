// Chat replies are GitHub-flavoured markdown (the dashboard renders them); Slack speaks
// "mrkdwn". Convert the common constructs so replies read the same in both places.
// Code (fenced blocks and inline spans) is passed through untouched.

const SLACK_MAX = 39_000; // Slack caps message text at 40k characters

function convertProse(s: string): string {
  return s
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '\u0001$1\u0001') // headings → bold line
    .replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0001') // **bold** (placeholder so the italic rule skips it)
    .replace(/__(.+?)__/g, '\u0001$1\u0001')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_') // *italic* → _italic_
    .replace(/\u0001/g, '*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/!?\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>') // [text](url) → <url|text>
    .replace(/^(\s*)- \[( |x)\]\s+/gim, (_m, sp, x) => `${sp}${x.trim() ? '☑' : '☐'} `) // task lists (before bullets)
    .replace(/^(\s*)[-*+]\s+/gm, '$1• '); // bullets
}

/** Markdown → Slack mrkdwn. */
export function toMrkdwn(md: string): string {
  const out: string[] = [];
  // split into fenced code blocks and the rest; inside the rest, keep `inline code` untouched
  const parts = md.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```')) {
      out.push(part.replace(/^```[\w-]*\n/, '```\n')); // Slack ignores language tags
      continue;
    }
    out.push(
      part
        .split(/(`[^`\n]+`)/g)
        .map((seg) => (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1 ? seg : convertProse(seg)))
        .join(''),
    );
  }
  const text = out.join('');
  return text.length > SLACK_MAX ? `${text.slice(0, SLACK_MAX)}\n… (truncated — the full reply is in the dashboard chat)` : text;
}

/** One quiet line naming the tools a turn used, like the chips under a dashboard reply. */
export function actionsFooter(actions: { name: string; ok: boolean }[] | undefined): string {
  if (!actions?.length) return '';
  const names = actions.map((a) => `${a.name}${a.ok ? '' : ' ✗'}`);
  return `\n_${[...new Set(names)].join(' · ')}_`;
}
