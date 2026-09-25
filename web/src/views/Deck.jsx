import { useEffect, useState } from 'react';

/** Mission Deck lives in a child process; health.deckUrl is null when it is not running. */
export default function DeckView({ health }) {
  const deckUrl = health?.deckUrl ?? null;
  const [reachable, setReachable] = useState(null);

  useEffect(() => {
    if (!deckUrl) {
      setReachable(false);
      return;
    }
    let live = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    fetch(deckUrl, { mode: 'no-cors', signal: ctrl.signal })
      .then(() => live && setReachable(true))
      .catch(() => live && setReachable(false))
      .finally(() => clearTimeout(t));
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [deckUrl]);

  if (!deckUrl || reachable === false) {
    return (
      <section>
        <h2 style={{ margin: '18px 0' }}>Deck</h2>
        <div className="panel muted" data-testid="deck-off">
          <strong>Deck not running.</strong> Mission Deck is supervised by alfred (port 8787);
          it is not started or not reachable right now.
        </div>
      </section>
    );
  }
  if (!health) return <div className="panel muted">Loading…</div>;

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>Deck</h2>
      <iframe
        title="Mission Deck"
        src={deckUrl}
        style={{ width: '100%', height: 'calc(100vh - 120px)', border: '1px solid var(--line, #222)', borderRadius: 10, background: '#fff' }}
      />
    </section>
  );
}
