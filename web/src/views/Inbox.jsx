// Placeholder until P17d: the P5 approvals view.
import Legacy from '../legacy/Approvals.jsx';
import { useTick } from '../lib/legacy.jsx';

export default function Inbox() {
  const tick = useTick(['approval_', 'transition']);
  return <div className="page legacy"><h1>Inbox</h1><Legacy tick={tick} /></div>;
}
