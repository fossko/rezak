import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';
import './notify';

createRoot(document.getElementById('root')!).render(<App />);

// The app itself never zooms: a trackpad pinch arrives as wheel + ctrlKey, and ⌘= / ⌘− are browser zoom
// keys. Both are cancelled everywhere; the waveform handles them itself (zooms only the waveform).
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(e.code)) e.preventDefault();
});
// Safari's own pinch events (harmless in Chrome)
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// Service worker: caches the app shell and the ONNX runtime so Carver opens offline after the first visit.
if ('serviceWorker' in navigator && import.meta.env.PROD && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e)); });
}
