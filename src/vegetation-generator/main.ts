import { App } from './app';

const container = document.getElementById('vegetation-generator-app');

if (!container) {
  throw new Error('Vegetation Generator container was not found');
}

const app = new App(container);

app.start().catch((err: Error) => {
  console.error(err);
  const el = document.createElement('div');
  el.className = 'fatal';
  el.textContent = `Failed to start the renderer: ${err.message}. ` +
    'This app needs WebGPU or WebGL2 — try a recent Chrome, Edge or Firefox.';
  document.body.appendChild(el);
});
