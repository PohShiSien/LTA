import React from 'react';
import ReactDOM from 'react-dom/client';
import SubsystemWorkspace from './pages/SubsystemWorkspace';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './base.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SubsystemWorkspace /></React.StrictMode>,
);
