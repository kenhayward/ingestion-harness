import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { httpApi } from './api/client.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={httpApi} />
  </StrictMode>,
);
