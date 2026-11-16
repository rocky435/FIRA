import './sentry.js'; // ponytail: must be first import for early error capture
import '@fontsource-variable/inter'; // ponytail: self-hosted Inter via Vite build (replaces Google Fonts CDN)
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// The offline page, installability and admin alerts (public/sw.js). Registered
// in development too, so "Install app" and alerts can be tried on localhost:
// the worker only answers page loads that fail and push messages, so it does
// not get in the way of Vite's live reload.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err?.message);
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
