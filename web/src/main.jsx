import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import './legacy/legacy.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import App from './App.jsx';
import { captureToken } from './api.js';

captureToken();
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
