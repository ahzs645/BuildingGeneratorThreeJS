/**
 * Canvas sizing for the docked studio shell.
 *
 * Tool runtimes used to size their renderer from `innerWidth`/`innerHeight`,
 * which was correct while every canvas covered the whole viewport under
 * floating panels. The viewport is a grid column now — bounded by the rail,
 * the docks, the toolbar, and the status bar — so a window-sized drawing
 * buffer overshoots the element and stretches the render.
 *
 * Both helpers report CSS pixels; pass them to `renderer.setSize(w, h, false)`
 * so three.js never writes inline width/height back onto the canvas and starts
 * a feedback loop with the observer.
 */

export type CanvasBox = { width: number; height: number };

export const MOBILE_CANVAS_BREAKPOINT = 820;

/**
 * Choose a conservative initial drawing-buffer scale for touch/small-screen
 * devices. A 1.5× buffer has 44% fewer pixels than 2× while remaining crisp
 * on a phone; desktop keeps the existing 2× ceiling.
 */
export function canvasPixelRatioFor(
  deviceRatio: number,
  viewportWidth: number,
  coarsePointer: boolean,
  desktopMaximum = 2,
): number {
  const safeRatio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  const safeMaximum = Number.isFinite(desktopMaximum) && desktopMaximum > 0
    ? desktopMaximum
    : 2;
  const mobileMaximum = Math.min(1.5, safeMaximum);
  const maximum = viewportWidth <= MOBILE_CANVAS_BREAKPOINT || coarsePointer
    ? mobileMaximum
    : safeMaximum;
  return Math.min(safeRatio, maximum);
}

/** Browser-bound wrapper used by Three.js runtimes during renderer setup. */
export function preferredCanvasPixelRatio(desktopMaximum = 2): number {
  return canvasPixelRatioFor(
    window.devicePixelRatio,
    window.innerWidth,
    window.matchMedia("(pointer: coarse)").matches,
    desktopMaximum,
  );
}

/** The canvas's current CSS box, never smaller than 1×1. */
export function canvasBox(element: HTMLElement): CanvasBox {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/**
 * Call `onResize` with the element's box now and on every later change.
 * Returns the disposer; runtimes must call it from `dispose()` so leaving and
 * re-entering a tool never accumulates observers.
 */
export function observeCanvasBox(
  element: HTMLElement,
  onResize: (width: number, height: number) => void,
): () => void {
  const apply = (): void => {
    const { width, height } = canvasBox(element);
    onResize(width, height);
  };
  const observer = new ResizeObserver(apply);
  observer.observe(element);
  apply();
  return () => observer.disconnect();
}
