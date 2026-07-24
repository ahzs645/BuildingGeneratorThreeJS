import { useEffect, useRef } from "react";
import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./geometry-painter.css";

export default function GeometryPainterPage(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  usePageRuntime("Geometry Painter · three.js WebGPU");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let dispose = (): void => {};
    void import("../../geometry-painter/main")
      .then(({ mountGeometryPainter }) => mountGeometryPainter(container))
      .then((cleanup) => {
        if (active) dispose = cleanup;
        else cleanup();
      });

    return () => {
      active = false;
      dispose();
    };
  }, []);

  return (
    <main className="geometry-painter-page">
      <div id="geometry-painter-app" ref={containerRef} />
      <div id="drawFrame" />
      <div id="geometry-painter-title">
        <span aria-hidden="true">💎</span> Geometry Painter <small>three.js WebGPU</small>
      </div>
      <button id="modeBtn" type="button" aria-label="Toggle between paint and orbit modes">
        <span className="dot" />
        <span className="label">Paint mode</span>
        <span className="key">D</span>
      </button>
      <div id="hud" />
      <div id="toast" role="status" aria-live="polite" />
      <StudioLink />
    </main>
  );
}
