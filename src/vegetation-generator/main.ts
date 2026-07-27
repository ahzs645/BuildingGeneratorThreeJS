import type { ToolHandle } from '../react/page-runtime';
import { App } from './app';

export function createTool(): ToolHandle {
  const container = document.getElementById('vegetation-generator-app');

  if (!container) {
    throw new Error('Vegetation Generator container was not found');
  }

  const app = new App(container);
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
    document.body.appendChild(fatalEl);
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      app.dispose();
      fatalEl?.remove();
      fatalEl = null;
    },
  };
}
