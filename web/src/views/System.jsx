// System: overview, services, qwen, logs, config, models, personas, nodes, repos, builds, connectors, contacts.
// Legacy hashes #/personas, #/models, #/nodes land on those tabs (App.jsx maps them here).
import { useRoute, href } from '../lib/router.js';
import { Tabs } from '../ui/index.jsx';
import Overview from './system/Overview.jsx';
import Services from './system/Services.jsx';
import QwenTab from './system/Qwen.jsx';
import Logs from './system/Logs.jsx';
import Config from './system/Config.jsx';
import ModelsTab from './system/ModelsTab.jsx';
import PersonasTab from './system/PersonasTab.jsx';
import NodesTab from './system/NodesTab.jsx';
import ReposTab from './system/ReposTab.jsx';
import BuildsTab from './system/BuildsTab.jsx';
import Connectors from './system/Connectors.jsx';
import Contacts from './system/Contacts.jsx';
import './System.css';

const TABS = [
  ['overview', 'Overview'], ['services', 'Services'], ['qwen', 'Qwen'], ['logs', 'Logs'], ['config', 'Config'],
  ['models', 'Models'], ['personas', 'Personas'], ['nodes', 'Nodes'], ['repos', 'Repos'], ['builds', 'Builds'], ['connectors', 'Connectors'], ['contacts', 'Contacts'],
];
const VIEWS = {
  overview: Overview, services: Services, qwen: QwenTab, logs: Logs, config: Config,
  models: ModelsTab, personas: PersonasTab, nodes: NodesTab, repos: ReposTab, builds: BuildsTab, connectors: Connectors, contacts: Contacts,
};

export default function System({ tab }) {
  const { query } = useRoute();
  const id = VIEWS[tab] ? tab : 'overview';
  const View = VIEWS[id];
  return (
    <div className="page system-page">
      <div className="page-head">
        <h1>System</h1>
        <span className="sub">the Spark, from wherever you are</span>
      </div>
      <div className="sys-tabs-wrap">
        <Tabs value={id} tabs={TABS} hrefFor={(t) => href(`/system/${t}`)} />
      </div>
      <View file={query.file} />
    </div>
  );
}
