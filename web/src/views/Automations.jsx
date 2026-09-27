// Placeholder until P17e: the P5 automations view.
import Legacy from '../legacy/Automations.jsx';
import { useTick } from '../lib/legacy.jsx';

export default function Automations() {
  const tick = useTick(['automation_']);
  return <div className="page legacy"><h1>Automations</h1><Legacy tick={tick} /></div>;
}
