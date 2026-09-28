// Kanban: horizontally scrollable columns with drop handling, WIP counts and quick-add.
import { Fragment, useRef, useState } from 'react';
import Card from './Card.jsx';
import { overWip } from './model.js';

function QuickAdd({ column, onCreate }) {
  const [v, setV] = useState('');
  return (
    <input
      className="quick-add"
      data-testid={`quick-add-${column.id}`}
      placeholder="Add item…"
      aria-label={`Add item to ${column.name}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const t = v.trim();
          setV(''); // keep focus, clear the text
          if (t) onCreate(column.id, t);
        } else if (e.key === 'Escape') {
          setV('');
        }
      }}
    />
  );
}

export default function Columns({ columns, byCol, goalStatus, onOpen, onMoveTo, onArchive, onCreate, onDropItem }) {
  const hintRef = useRef(null);
  const [hint, setHint] = useState(null);
  const drag = useRef({
    key: null,
    columnId: null,
    beforeId: null,
    set(h) { hintRef.current = h; setHint(h); },
  }).current;

  const clear = () => { drag.key = null; drag.columnId = null; drag.beforeId = null; drag.set(null); };

  return (
    <div className="board-cols">
      {columns.map((col) => {
        const list = byCol.get(col.id) ?? [];
        const over = overWip(col, list.length);
        return (
          <div
            key={col.id}
            className={`bcol ${drag.key && hint?.columnId === col.id ? 'drag-over' : ''}`}
            data-testid={`board-column-${col.id}`}
            onDragOver={(e) => {
              if (!drag.key) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const key = e.dataTransfer.getData('text/plain') || drag.key;
              const beforeId = drag.columnId === col.id ? drag.beforeId : null;
              clear();
              if (key) onDropItem(key, col.id, beforeId);
            }}
          >
            <div className="bcol-head">
              <span className="name">{col.name}</span>
              <span className="count">{list.length}</span>
              {col.wip != null && (
                <span className={`grow wip ${over ? 'over' : ''}`} title={over ? 'Over the WIP limit' : `WIP limit: ${col.wip}`}>
                  {list.length}/{col.wip}
                </span>
              )}
            </div>
            <div className="bcol-cards">
              {list.map((it) => (
                <Fragment key={it.id}>
                  {hint?.columnId === col.id && hint.beforeId === it.id && <div className="bdrop on" />}
                  <Card
                    item={it}
                    columns={columns}
                    siblings={list}
                    goalStatus={goalStatus}
                    drag={drag}
                    onOpen={onOpen}
                    onMoveTo={onMoveTo}
                    onArchive={onArchive}
                  />
                </Fragment>
              ))}
              {hint?.columnId === col.id && !hint.beforeId && <div className="bdrop on" />}
            </div>
            <QuickAdd column={col} onCreate={onCreate} />
          </div>
        );
      })}
    </div>
  );
}
