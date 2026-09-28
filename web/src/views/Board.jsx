// P17b — the board: toolbar, kanban (drag & drop), list view, item drawer, board settings.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { useResource } from '../lib/live.jsx';
import { go, setQuery, useRoute } from '../lib/router.js';
import { Button, Empty, Spinner, useToast } from '../ui/index.jsx';
import Columns from './board/Columns.jsx';
import ListView from './board/ListView.jsx';
import ItemDrawer from './board/ItemDrawer.jsx';
import Settings from './board/Settings.jsx';
import { filterItems, groupByColumn, rememberDrop, sortItems } from './board/model.js';
import './Board.css';

/** Segmented Board|List switch; the test ids are part of the acceptance contract. */
function ViewSeg({ value, onChange }) {
  return (
    <div className="seg" role="group" aria-label="View">
      {[['board', 'Board'], ['list', 'List']].map(([id, label]) => (
        <button key={id} type="button" data-testid={`view-${id}`} className={value === id ? 'on' : ''}
          aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Board({ itemKey }) {
  const { query } = useRoute();
  const { toast } = useToast();
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('board.view') || 'board'; } catch { return 'board'; }
  });
  const [text, setText] = useState('');
  const [mine, setMine] = useState(false);
  const [settings, setSettings] = useState(false);
  const [sort, setSort] = useState({ key: 'updated', dir: -1 });
  const [goalMap, setGoalMap] = useState({});

  const boardsR = useResource('/api/boards', { on: ['board_'] });
  const boards = boardsR.data ?? [];
  const board = useMemo(
    () => boards.find((b) => b.key === query.board) ?? boards[0] ?? null,
    [boards, query.board],
  );
  const itemsR = useResource(board ? `/api/items?board=${encodeURIComponent(board.key)}` : null, { on: ['item_', 'board_'] });

  // Goal statuses for the bot chip on cards (cheap full list, kept live).
  const goalsR = useResource('/api/goals', { on: ['goal_', 'transition'] });
  useEffect(() => {
    if (!goalsR.data) return;
    setGoalMap((m) => {
      const next = { ...m };
      for (const g of goalsR.data) next[g.id] = g.status;
      return next;
    });
  }, [goalsR.data]);
  const goalStatus = useCallback((id) => goalMap[id] ?? null, [goalMap]);

  const items = itemsR.data ?? [];
  const shown = useMemo(() => filterItems(items, { text, mine }), [items, text, mine]);
  const byCol = useMemo(() => groupByColumn(shown, board?.columns ?? []), [shown, board]);
  const listSorted = useMemo(() => sortItems(shown, sort.key, sort.dir, board?.columns ?? []), [shown, sort, board]);

  const itemsRRef = useRef(null);
  itemsRRef.current = itemsR;
  const fail = (e) => toast(e?.message ?? String(e), 'bad');

  const patchItems = (key, patch) => {
    const r = itemsRRef.current;
    r?.setData?.((prev) => (prev ?? []).map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const create = async (columnId, title) => {
    try {
      const it = await post('/api/items', { board: board.key, title, status: columnId });
      const r = itemsRRef.current;
      r?.setData?.((prev) => ((prev ?? []).some((x) => x.id === it.id) ? prev : [...prev, it]));
    } catch (e) { fail(e); }
  };

  const moveTo = async (key, columnId, { beforeId, afterId } = {}) => {
    patchItems(key, { columnId });
    try {
      const body = { status: columnId };
      if (beforeId) body.beforeId = beforeId;
      if (afterId) body.afterId = afterId;
      await post(`/api/items/${encodeURIComponent(key)}/move`, body);
    } catch (e) { fail(e); }
    itemsRRef.current?.reload();
  };

  // Drag & drop: optimistic reorder, then persist. Remember where the card visually landed
  // so a live refetch racing the POST cannot snap it back.
  const pendingDrop = useRef(null);
  const onDropItem = async (key, columnId, beforeId) => {
    const r = itemsRRef.current;
    const moved = (r?.data ?? []).find((x) => x.key === key);
    if (moved) {
      r?.setData?.((prev) => rememberDrop(prev ?? [], moved, columnId, beforeId));
      pendingDrop.current = { key, columnId, until: Date.now() + 2500 };
    }
    await moveTo(key, columnId, beforeId ? { beforeId } : {});
  };
  const byColShown = useMemo(() => {
    const p = pendingDrop.current;
    if (!p || p.until < Date.now()) return byCol;
    const out = new Map(byCol);
    const col = out.get(p.columnId);
    if (col) out.set(p.columnId, [...col].sort((a, b) => a.rank - b.rank));
    return out;
  }, [byCol, items]);

  const archive = async (key) => {
    patchItems(key, { archived: true });
    try { await api(`/api/items/${encodeURIComponent(key)}`, { method: 'DELETE' }); } catch (e) { fail(e); }
    itemsRRef.current?.reload();
  };

  const q = query.board ? { board: query.board } : {};
  const open = (key) => go(`/board/${key}`, q);
  const closeDrawer = () => go('/board', q);
  const drawerItem = itemKey
    ? items.find((it) => String(it.key).toUpperCase() === String(itemKey).toUpperCase())
    : null;

  const selectMode = (m) => {
    setMode(m);
    try { localStorage.setItem('board.view', m); } catch { /* private mode */ }
  };
  const onSortHeader = (k) => setSort((s) => (s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: 1 }));

  if (!boards.length) {
    return (
      <div className="page">
        {boardsR.loading
          ? <div className="row" style={{ padding: 'var(--s-6)' }}><Spinner size={22} /></div>
          : <Empty icon="board" title="No boards yet" />}
      </div>
    );
  }

  return (
    <div className="page board-page">
      <div className="board-toolbar">
        {boards.length > 1 ? (
          <select
            className="select board-switch"
            data-testid="board-switch"
            aria-label="Board"
            value={board.key}
            onChange={(e) => setQuery({ board: e.target.value })}
          >
            {boards.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
          </select>
        ) : (
          <h1 className="board-name">{board.name}</h1>
        )}
        <ViewSeg value={mode} onChange={selectMode} />
        <span className="grow" />
        <input
          className="input board-filter"
          data-testid="board-filter"
          placeholder="Filter by title, key or label…"
          aria-label="Filter items"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className={`btn sm ${mine ? 'primary' : ''}`}
          aria-pressed={mine}
          title="Items assigned to quinn"
          onClick={() => setMine((m) => !m)}
        >
          Mine
        </button>
        <Button variant="ghost" icon="settings" aria-label="Board settings" data-testid="board-settings" onClick={() => setSettings(true)} />
      </div>

      {mode === 'board' ? (
        <Columns
          columns={board.columns}
          byCol={byColShown}
          goalStatus={goalStatus}
          onOpen={open}
          onMoveTo={(key, columnId) => moveTo(key, columnId)}
          onArchive={archive}
          onCreate={create}
          onDropItem={onDropItem}
        />
      ) : (
        <ListView
          items={listSorted}
          board={board}
          onOpen={open}
          onMove={(key, columnId) => moveTo(key, columnId)}
          sort={sort}
          onSortHeader={onSortHeader}
        />
      )}

      {itemKey && (
        <ItemDrawer
          itemKey={itemKey}
          board={board}
          item={drawerItem}
          goalStatus={goalStatus}
          onClose={closeDrawer}
          onChanged={() => itemsRRef.current?.reload()}
          onPatch={patchItems}
        />
      )}
      {settings && (
        <Settings
          board={board}
          onClose={() => setSettings(false)}
          onCreated={(b) => setQuery({ board: b.key })}
        />
      )}
    </div>
  );
}
