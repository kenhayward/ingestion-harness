import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { App } from './App.js';
import { httpApi } from './api/client.js';
import { applyTheme, loadTheme } from './theme.js';
import './styles/tokens.css';
import './styles.css';

// Before the first render, so a stored Light/Dark choice never flashes the other theme.
applyTheme(loadTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={httpApi} />
  </StrictMode>,
);
