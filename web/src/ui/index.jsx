// UI primitives. Views import from here; keep them presentational (no fetching).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Icon } from './icons.jsx';
import { initials, isAgent } from '../lib/format.js';

export { Icon };

export function Button({ variant, size, icon, children, className = '', ...rest }) {
  const cls = ['btn', variant, size, !children && icon ? 'icon' : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="loading" />;
}

export function Empty({ icon = 'sparkles', title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} className="icon" />
      {title && <div className="muted">{title}</div>}
      {children && <div className="small">{children}</div>}
    </div>
  );
}

/** Status chip for task/goal statuses (and any tone class from components.css). */
export function StatusChip({ status, children, tone }) {
  return (
    <span className={`chip ${tone ?? status}`}>
      <span className="dot" />
      {children ?? String(status).replace('_', ' ')}
    </span>
  );
}

export function Prio({ p }) {
  if (!p || p === 'none') return <span className="prio" title="No priority"><i /><i /><i /></span>;
  return <span className={`prio ${p}`} title={`Priority: ${p}`}><i /><i /><i /></span>;
}

export function Avatar({ who, title }) {
  if (!who) return null;
  const cls = who === 'quinn' ? 'me' : isAgent(who) ? 'agent' : '';
  return <span className={`avatar ${cls}`} title={title ?? who}>{isAgent(who) ? <Icon name="bot" size={12} /> : initials(who)}</span>;
}

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, hrefFor }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => {
        const [id, label] = Array.isArray(t) ? t : [t.id, t.label];
        const props = hrefFor ? { href: hrefFor(id) } : { onClick: () => onChange?.(id) };
        const El = hrefFor ? 'a' : 'button';
        return (
          <El key={id} role="tab" aria-selected={value === id} className={`tab ${value === id ? 'active' : ''}`} {...props}>
            {label}
          </El>
        );
      })}
    </div>
  );
}

export function Seg({ options, value, onChange }) {
  return (
    <div className="seg" role="group">
      {options.map(([id, label]) => (
        <button key={id} type="button" className={value === id ? 'on' : ''} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function useEscape(onClose) {
  useEffect(() => {
    const on = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide, testId }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" icon="x" className="x" aria-label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ onClose, head, children, testId }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <aside className="drawer" role="dialog" aria-modal="true" data-testid={testId}>
        <div className="drawer-head">
          {head}
          <Button variant="ghost" icon="x" aria-label="Close" onClick={onClose} style={{ marginLeft: 'auto' }} />
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Dropdown menu. `trigger` is rendered as-is; items = [{label, icon?, onClick, danger?} | 'sep']. */
export function Menu({ trigger, items, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const on = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  useEscape(open ? () => setOpen(false) : null);
  return (
    <span className="popover-anchor" ref={ref}>
      <span onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{trigger}</span>
      {open && (
        <div className="menu" style={{ top: '100%', marginTop: 4, [align]: 0 }} role="menu">
          {items.filter(Boolean).map((it, i) =>
            it === 'sep' ? <div key={i} className="sep" /> : (
              <button key={i} role="menuitem" style={it.danger ? { color: 'var(--bad)' } : undefined}
                onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick?.(); }}>
                {it.icon && <Icon name={it.icon} size={14} />}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </span>
  );
}

marked.setOptions({ gfm: true, breaks: true });
export function Markdown({ text, className = '' }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(String(text ?? ''))), [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Meter({ value, max = 100, tone }) {
  const pct = Math.max(0, Math.min(100, (Number(value) / (max || 1)) * 100));
  const t = tone ?? (pct > 90 ? 'bad' : pct > 75 ? 'warn' : '');
  return <div className={`meter ${t}`} role="meter" aria-valuenow={value} aria-valuemax={max}><span style={{ width: `${pct}%` }} /></div>;
}

/** Tiny area sparkline from numbers. */
export function Sparkline({ values = [], height = 36 }) {
  const w = 120;
  if (!values.length) return <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" />;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${w},${height}L0,${height}Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="area" d={area} />
      <path className="line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Stat({ k, v, d, children }) {
  return (
    <div className="card stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {d && <div className="d">{d}</div>}
      {children}
    </div>
  );
}

// ---------- toasts + confirm ----------
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, tone = '') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  const [confirmState, setConfirm] = useState(null);
  const confirm = useCallback(
    (opts) => new Promise((resolve) => setConfirm({ ...(typeof opts === 'string' ? { title: opts } : opts), resolve })),
    [],
  );
  const close = (v) => {
    confirmState?.resolve(v);
    setConfirm(null);
  };
  return (
    <ToastCtx.Provider value={{ push, confirm }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
      {confirmState && (
        <Modal title={confirmState.title ?? 'Are you sure?'} onClose={() => close(false)} testId="confirm-dialog"
          footer={<>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={confirmState.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {confirmState.ok ?? 'Confirm'}
            </Button>
          </>}>
          {confirmState.body && <p className="muted">{confirmState.body}</p>}
        </Modal>
      )}
    </ToastCtx.Provider>
  );
}

/** const { toast, confirm } = useToast(); toast('Saved', 'ok'); if (await confirm({title, body, danger})) … */
export function useToast() {
  const ctx = useContext(ToastCtx);
  return { toast: ctx?.push ?? (() => {}), confirm: ctx?.confirm ?? (async () => window.confirm('Are you sure?')) };
}

/** Wrap an async action: shows errors as a toast; returns the result or undefined. */
export function useAction() {
  const { toast } = useToast();
  return useCallback(async (fn, okText) => {
    try {
      const r = await fn();
      if (okText) toast(okText, 'ok');
      return r;
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
      return undefined;
    }
  }, [toast]);
}
