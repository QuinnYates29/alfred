// QWEN_EXTRA ⇄ editable {flag, value} rows. Mirrors src/ops/qwen.ts (the server re-validates).
const FORBIDDEN = /[;|&$`<>\\"'\u0000-\u001f\u007f]/;
const FLAG_RE = /^--?[A-Za-z][A-Za-z0-9_-]*$/;
const isFlag = (t) => /^--?[A-Za-z]/.test(t);
export const FORBIDDEN_MSG = 'no ; | & $ ` < > \\ quotes or newlines';

/** text → rows; throws Error with a reason. */
export function parseExtra(text) {
  if (FORBIDDEN.test(text)) throw new Error(`extra flags: ${FORBIDDEN_MSG}`);
  const rows = [];
  for (const tok of String(text).split(/[ \t]+/).filter(Boolean)) {
    if (isFlag(tok)) {
      if (!FLAG_RE.test(tok)) throw new Error(`bad flag: ${tok}`);
      rows.push({ flag: tok, value: '' });
    } else if (!rows.length) {
      throw new Error(`flags must start with -: ${tok}`);
    } else {
      const last = rows[rows.length - 1];
      last.value = last.value ? `${last.value} ${tok}` : tok;
    }
  }
  return rows;
}

/** A row's problem, or '' when it is fine. */
export function rowError({ flag, value }) {
  const f = flag.trim();
  if (!f) return 'flag is empty';
  if (!FLAG_RE.test(f)) return 'flags start with - or -- then letters';
  if (FORBIDDEN.test(f) || FORBIDDEN.test(value)) return FORBIDDEN_MSG;
  if (value.trim().split(/\s+/).some((t) => isFlag(t))) return 'value looks like another flag; add a row';
  return '';
}

export function joinRows(rows) {
  return rows
    .filter((r) => r.flag.trim())
    .map((r) => (r.value.trim() ? `${r.flag.trim()} ${r.value.trim().split(/\s+/).join(' ')}` : r.flag.trim()))
    .join(' ');
}
