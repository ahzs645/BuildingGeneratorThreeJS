import type { ToolHandle } from '../react/page-runtime';
import { App, type Generator } from './app';

/** `?mode=` deep links used by the studio menu presets and legacy redirects. */
const MODE_PARAM: Record<string, Generator> = {
  ivy: 'Ivy',
  tree: 'Tree',
  crystals: 'Crystals',
  fissures: 'Molten fissures',
  aurora: 'Aurora silk',
  reef: 'Bioluminescent reef',
};

export function createTool(): ToolHandle {
  const container = document.getElementById('surface-painter-app');
  if (!container) {
    throw new Error('Surface Painter container was not found');
  }

  const mode = new URLSearchParams(window.location.search).get('mode');
  const app = new App(container, MODE_PARAM[mode ?? ''] ?? 'Ivy');
  let disposed = false;
  let fatalEl: HTMLDivElement | null = null;

  // Async renderer init stays internal — the handle is usable immediately, and App
  // guards its own start() against a dispose() that lands mid-initialization.
  app.start().catch((err: Error) => {
    console.error(err);
    if (disposed) return;
    fatalEl = document.createElement('div');
    fatalEl.className = 'fatal';
    fatalEl.textContent = `Failed to start the renderer: ${err.message}. ` +
      'This app needs WebGPU or WebGL2 — try a recent Chrome, Edge or Firefox.';
    container.appendChild(fatalEl);
  });

  return {
    dispose(): void {
      disposed = true;
      fatalEl?.remove();
      fatalEl = null;
      app.dispose();
    },
  };
}
