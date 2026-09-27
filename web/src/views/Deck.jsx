// Mission Deck (personal tasks, calendar, briefing) in a frame. Placeholder wrapper around the P5 view.
import Legacy from '../legacy/Deck.jsx';
import { useResource } from '../lib/live.jsx';

export default function Deck() {
  const { data } = useResource('/api/health', { interval: 15000 });
  return <div className="page full legacy"><Legacy health={data} tick={0} /></div>;
}
