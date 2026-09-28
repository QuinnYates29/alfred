// P21a — in-process calls to alfred's own HTTP API (deps.selfUrl, set after listen).
// Going through the routes keeps one code path (validation, event log) for the
// dashboard and the agents alike.
import type { ModuleDeps } from '../modules.js';

export interface ApiResult {
  status: number;
  ok: boolean;
  body: any;
}

export async function selfApi(deps: ModuleDeps, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const base = deps.selfUrl;
  if (!base) throw new Error('the platform API is not up yet');
  const f: typeof fetch = (deps.extra?.selfFetch as typeof fetch | undefined) ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await f(`${base}/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/** The route's error message (or a short status line). */
export function apiError(r: ApiResult): string {
  const msg = r.body && typeof r.body === 'object' && r.body.error ? String(r.body.error) : '';
  return `http ${r.status}${msg ? `: ${msg}` : ''}`;
}

/** Compact text for the model: never more than `max` chars. */
export function clip(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n… (${s.length - max + 20} more chars)`;
}
