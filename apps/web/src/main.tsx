import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { App } from './App.js';
import { httpApi } from './api/client.js';
import './pwa/install.js'; // listens for the browser's install offer before the first render
import { consumeLaunches, goTo, launchedFiles, type LaunchQueue } from './pwa/launch.js';
import { registerServiceWorker } from './pwa/register.js';
import { applyTheme, loadTheme } from './theme.js';
import './styles/tokens.css';
import './styles.css';
import './styles/stages.css';

// Before the first render, so a stored Light/Dark choice never flashes the other theme.
applyTheme(loadTheme());

// The installed app (docs/design/pwa.md): files opened with it, shortcuts, the offline page.
consumeLaunches((window as { launchQueue?: LaunchQueue }).launchQueue, launchedFiles, goTo);
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={httpApi} />
  </StrictMode>,
);
