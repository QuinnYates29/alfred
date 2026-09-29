// J2 §6 — the done-gate review verdict badge (data = the task's latest `review` event data):
// pass/reject, quality x/4 and the failure mode. Renders nothing when there is no review.
const short = (n) => (typeof n === 'number' ? String(Math.round(n * 100) / 100) : '?');

export default function ReviewBadge({ data }) {
  if (!data || !data.verdict) return null;
  const reject = data.verdict === 'reject';
  const q = typeof data.quality === 'number' ? data.quality : null;
  const mode = data.failureMode && data.failureMode !== 'none' ? data.failureMode : null;
  const tip =
    `Jev review (${data.mode ?? '?'}): addresses_spec ${short(data.addresses)}, complete ${short(data.complete)}, ` +
    `quality ${q ?? '?'}/4, failure_mode ${data.failureMode ?? 'none'}, ${data.ms ?? 0} ms`;
  return (
    <span className={`chip ${reject ? 'bad' : 'ok'}`} title={tip} data-testid="review-badge">
      review {reject ? 'rejected' : 'passed'}
      {q != null ? ` · ${q}/4` : ''}
      {mode ? ` · ${mode}` : ''}
    </span>
  );
}
