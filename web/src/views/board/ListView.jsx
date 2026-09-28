// List view: sortable table; Status is an inline select that moves the item; row click opens the drawer.
import { dueInfo, timeAgo } from '../../lib/format.js';
import { Avatar, Empty, Icon, Prio } from '../../ui/index.jsx';

const COLUMNS = [
  ['key', 'Key'],
  ['title', 'Title'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['assignee', 'Assignee'],
  ['due', 'Due'],
  ['labels', 'Labels'],
  ['updated', 'Updated'],
];

export default function ListView({ items, board, onOpen, onMove, sort, onSortHeader }) {
  const { key, dir } = sort;
  return (
    <div className="card list-wrap">
      <table className="table">
        <thead>
          <tr>
            {COLUMNS.map(([k, label]) => (
              <th
                key={k}
                className="sortable"
                aria-sort={key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}
                onClick={() => onSortHeader(k)}
                title={`Sort by ${label}`}
              >
                {label}{key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const due = dueInfo(it.due);
            return (
              <tr key={it.id} className="link" data-testid={`list-row-${it.key}`} onClick={() => onOpen(it.key)}>
                <td><span className="key">{it.key}</span></td>
                <td style={{ maxWidth: 340 }}><span className="ellipsis" style={{ display: 'block' }}>{it.title}</span></td>
                <td>
                  <select
                    className="select row-status"
                    aria-label={`Status of ${it.key}`}
                    value={it.columnId}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onMove(it.key, e.target.value)}
                  >
                    {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
                <td><Prio p={it.priority} /></td>
                <td>{it.assignee ? <Avatar who={it.assignee} title={it.assignee} /> : <span className="faint">–</span>}</td>
                <td>
                  {due
                    ? <span className={`due ${due.overdue ? 'over' : due.soon ? 'soon' : ''}`}><Icon name="calendar" size={11} />{due.label}</span>
                    : <span className="faint">–</span>}
                </td>
                <td>
                  <span className="row wrap" style={{ gap: 4 }}>
                    {(it.labels ?? []).slice(0, 3).map((l) => <span key={l} className="label-tag">{l}</span>)}
                    {(it.labels?.length ?? 0) > 3 && <span className="xs faint">+{it.labels.length - 3}</span>}
                  </span>
                </td>
                <td><span className="xs faint">{timeAgo(it.updatedAt)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!items.length && <Empty icon="list" title="No items match" />}
    </div>
  );
}
