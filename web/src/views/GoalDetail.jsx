// Placeholder until P17c: the P5 goal view inside the new shell.
import Legacy from '../legacy/GoalDetail.jsx';
import { useTick } from '../lib/legacy.jsx';

export default function GoalDetail({ id }) {
  const tick = useTick();
  return <div className="page legacy"><Legacy id={id} tick={tick} /></div>;
}
