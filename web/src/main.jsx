import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { captureToken } from './api.js';
import './index.css';

captureToken();
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
