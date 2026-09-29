// J2 — patterns for credential-shaped strings. The env redactor only knows the secrets alfred
// itself holds; this catches the rest (Slack/AWS/GitHub/OpenAI/JWT/PEM/Bearer/key=value) so a
// task deliverable or a scraped page never sends someone else's key to a cloud model.
type Repl = string | ((m: string, ...rest: string[]) => string);
const PATTERNS: [RegExp, Repl][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted:key>'],
  [/\bxox[a-z]-[A-Za-z0-9-]{8,}\b/g, '<redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '<redacted>'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted>'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer <redacted>'],
  [/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|apikey)\b(\s*[:=]\s*)["']?[^\s"',;}\]]{6,}/gi, (_m: string, k: string, sep: string) => `${k}${sep}<redacted>`],
];

/** Replace credential-shaped text. Applied to everything leaving for the Jev API. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as any);
  return out;
}
