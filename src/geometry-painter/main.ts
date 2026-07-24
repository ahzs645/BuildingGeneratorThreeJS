import { App } from './app';

type GeometryPainterDebugWindow = Window & {
  __geometryPainterApp?: App;
};

export async function mountGeometryPainter(container: HTMLElement): Promise<() => void> {
  const app = new App(container);

  try {
    await app.start();
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const fatal = document.createElement('div');
    fatal.className = 'fatal';
    fatal.textContent = `Failed to start the renderer: ${message}. ` +
      'This app needs WebGPU or WebGL2 — try a recent Chrome, Edge or Firefox.';
    container.appendChild(fatal);
    return () => fatal.remove();
  }

  const debugWindow = window as GeometryPainterDebugWindow;
  debugWindow.__geometryPainterApp = app;

  return () => {
    if (debugWindow.__geometryPainterApp === app) {
      delete debugWindow.__geometryPainterApp;
    }
    app.destroy();
  };
}
