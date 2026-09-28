// A kanban card: key, title, priority, labels, due, assignee, checklist progress, goal status, ⋯ menu.
// The shared `drag` object ({ key, columnId, beforeId, set }) is owned by Columns.jsx.
import { dueInfo } from '../../lib/format.js';
import { Avatar, Button, Icon, Menu, Prio, StatusChip } from '../../ui/index.jsx';
import { checklistProgress, dropBefore } from './model.js';

export default function Card({ item, columns, siblings, goalStatus, drag, onOpen, onMoveTo, onArchive }) {
  const due = dueInfo(item.due);
  const ck = checklistProgress(item);
  const goal = (item.goalIds ?? []).length ? goalStatus?.(item.goalIds[item.goalIds.length - 1]) : null;

  const menuItems = [
    ...columns.map((c) => ({ label: `Move to ${c.name}`, icon: 'board', onClick: () => onMoveTo(item.key, c.id) })),
    'sep',
    { label: 'Open', icon: 'chevronRight', onClick: () => onOpen(item.key) },
    { label: 'Archive', danger: true, onClick: () => onArchive(item.key) },
  ];

  return (
    <div
      className="bcard card hover"
      data-testid={`card-${item.key}`}
      draggable
      onClick={() => onOpen(item.key)}
      onDragStart={(e) => {
        drag.key = item.key;
        drag.set(null);
        e.dataTransfer.setData('text/plain', item.key);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => { drag.key = null; drag.set(null); }}
      onDragOver={(e) => {
        if (!drag.key || drag.key === item.key) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        drag.columnId = item.columnId;
        drag.beforeId = dropBefore(siblings, item.id, before);
        drag.set({ columnId: item.columnId, beforeId: drag.beforeId });
      }}
    >
      <div className="bcard-top">
        <Prio p={item.priority} />
        <span className="key">{item.key}</span>
        <span className="grow" />
        <Menu
          align="right"
          trigger={<Button variant="ghost" size="sm" icon="more" className="bcard-more" aria-label="More actions" title="More actions" />}
          items={menuItems}
        />
      </div>
      <div className="bcard-title">{item.title}</div>
      {(item.labels?.length || due || ck || item.assignee || goal) && (
        <div className="bcard-bottom">
          {(item.labels ?? []).map((l) => <span key={l} className="label-tag">{l}</span>)}
          {due && (
            <span className={`due ${due.overdue ? 'over' : due.soon ? 'soon' : ''}`} title={`Due ${item.due}`}>
              <Icon name="calendar" size={11} />{due.label}
            </span>
          )}
          {ck && (
            <span className="ck-progress" title="Checklist">
              <Icon name="checklist" size={11} />{ck}
            </span>
          )}
          <span className="grow" />
          {goal && (
            <StatusChip status={goal}>
              <Icon name="bot" size={11} />{String(goal).replace('_', ' ')}
            </StatusChip>
          )}
          {item.assignee && <Avatar who={item.assignee} title={item.assignee} />}
        </div>
      )}
    </div>
  );
}
