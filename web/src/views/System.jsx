// Placeholder until P17e: legacy personas/models/nodes as tabs.
import Personas from '../legacy/Personas.jsx';
import Models from '../legacy/Models.jsx';
import Nodes from '../legacy/Nodes.jsx';
import { Tabs } from '../ui/index.jsx';
import { useTick } from '../lib/legacy.jsx';

export default function System({ tab = 'personas' }) {
  const tick = useTick([]);
  const View = { personas: Personas, models: Models, nodes: Nodes }[tab] ?? Personas;
  return (
    <div className="page legacy">
      <h1>System</h1>
      <Tabs value={tab} tabs={[['personas', 'Personas'], ['models', 'Models'], ['nodes', 'Nodes']]} hrefFor={(t) => `#/system/${t}`} />
      <View tick={tick} />
    </div>
  );
}
