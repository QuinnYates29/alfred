// Secret redaction for stored output: agents print whatever they see (`env`, a config file…),
// and events / notes / results are persisted, mirrored to markdown and streamed to the UI.
// We replace the VALUES of secrets known at startup with «redacted:NAME».

export type Redactor = <T>(value: T) => T;

const NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)/i;
const ALWAYS_PREFIX = /^(ALFRED_TOKEN$|SLACK_|TWILIO_)/;
/** Env vars that name a location rather than hold a secret. */
const NOT_SECRET = /(_FILE|_PATH|_DIR|_ENV)$/i;
export const MIN_SECRET_LEN = 8;

/** Secret env vars worth redacting: name looks secret, value is long enough to be unambiguous. */
export function secretsFromEnv(env: Record<string, string | undefined>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LEN) continue;
    if (!(ALWAYS_PREFIX.test(name) || NAME_RE.test(name)) || NOT_SECRET.test(name)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ name, value });
  }
  // Longest first, so a secret that contains another is replaced whole.
  return out.sort((a, b) => b.value.length - a.value.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A redactor for these secrets: strings are rewritten, objects/arrays walked recursively. */
export function makeRedactor(secrets: { name: string; value: string }[]): Redactor {
  if (!secrets.length) return (v) => v;
  const byValue = new Map(secrets.map((s) => [s.value, s.name]));
  const re = new RegExp(secrets.map((s) => escapeRe(s.value)).join('|'), 'g');
  const str = (s: string): string => {
    re.lastIndex = 0;
    if (!re.test(s)) return s;
    re.lastIndex = 0;
    return s.replace(re, (m) => `«redacted:${byValue.get(m) ?? 'secret'}»`);
  };
  const walk = (v: any, depth: number): any => {
    if (typeof v === 'string') return str(v);
    if (!v || typeof v !== 'object' || depth > 50) return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    let changed = false;
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = walk(x, depth + 1);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  };
  return (v) => walk(v, 0);
}

export function envRedactor(env: Record<string, string | undefined>): Redactor {
  return makeRedactor(secretsFromEnv(env));
}
