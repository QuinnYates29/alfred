// Web hygiene for the HTTP server: constant-time token compare, the Host allow-list
// (DNS-rebinding guard), CSP + security headers, and single-use SSE tickets.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/** Constant-time string equality (SHA-256 digests, so lengths never leak either). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** `example.com:8443` / `[::1]:8790` / `[::1]` → lower-cased hostname without port or brackets. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.lastIndexOf(':');
  return colon >= 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

/**
 * Hostnames allowed in the `Host` header, besides loopback and IP literals (which cannot be
 * DNS-rebound): `ALFRED_ALLOWED_HOSTS` (comma list; `host` or `host:port`), the host of
 * `ALFRED_DASHBOARD_URL`, and a non-wildcard bind address.
 */
export function allowedHostsFromEnv(env: Record<string, string | undefined>, bindHost?: string): string[] {
  const out: string[] = [];
  for (const s of (env.ALFRED_ALLOWED_HOSTS ?? '').split(',')) if (s.trim()) out.push(hostnameOf(s));
  if (env.ALFRED_DASHBOARD_URL) {
    try {
      out.push(new URL(env.ALFRED_DASHBOARD_URL).hostname.replace(/^\[|\]$/g, '').toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') out.push(hostnameOf(bindHost));
  return [...new Set(out)];
}

/** True when a request with this Host header may be served. */
export function hostAllowed(hostHeader: string | undefined, allowed: string[] = []): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (LOOPBACK_NAMES.has(name)) return true;
  // An IP literal can't be the target of DNS rebinding (the attacker's page would be a different origin).
  if (isIP(name)) return true;
  return allowed.some((a) => a.toLowerCase() === name);
}

/** Express middleware: 421 for any Host that isn't loopback, an IP literal or explicitly allowed. */
export function hostGuard(allowed: string[] = []) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hostAllowed(req.headers.host, allowed)) return next();
    res.status(421).json({ error: 'misdirected request: unknown Host (set ALFRED_ALLOWED_HOSTS)' });
  };
}

/** The dashboard's Content-Security-Policy. `deckUrl` (Mission Deck, a child process) may be framed. */
export function contentSecurityPolicy(deckUrl?: string | null): string {
  const deck: string[] = [];
  if (deckUrl) {
    try {
      const u = new URL(deckUrl);
      deck.push(u.origin);
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        deck.push(`${u.protocol}//${u.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}${u.port ? `:${u.port}` : ''}`);
      }
    } catch {
      /* ignore */
    }
  }
  const extra = deck.length ? ` ${deck.join(' ')}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React sets style via the CSSOM (not governed by CSP); 'unsafe-inline' covers style="" in
    // server-rendered bits and Vite's dev overlay. Fonts are self-hosted (fontsource).
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src 'self'${extra}`,
    `frame-src 'self'${extra}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** CSP + nosniff + no-referrer (the token can appear in URLs) + no framing, on every response. */
export function securityHeaders(deckUrl?: () => string | null | undefined) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(deckUrl?.()));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
}

/**
 * Short-lived, single-use tickets for EventSource (which can't send an Authorization header):
 * the client trades its bearer token for a ticket and opens /api/events?ticket=….
 */
export class TicketBook {
  private readonly tickets = new Map<string, number>();
  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly max = 1000,
  ) {}

  issue(): { ticket: string; expiresAt: number } {
    this.prune();
    if (this.tickets.size >= this.max) {
      const oldest = this.tickets.keys().next().value;
      if (oldest !== undefined) this.tickets.delete(oldest);
    }
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  /** True once per valid, unexpired ticket. */
  consume(ticket: unknown): boolean {
    if (typeof ticket !== 'string' || !ticket) return false;
    const exp = this.tickets.get(ticket);
    if (exp === undefined) return false;
    this.tickets.delete(ticket);
    return exp > this.now();
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.tickets) if (exp <= t) this.tickets.delete(k);
  }
}
