import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./typewriter.css";

const loadTypewriter = () => import("../../typewriter");

export default function TypewriterPage(): React.JSX.Element {
  usePageRuntime("Node Dojo Typewriter · browser Geometry Nodes", loadTypewriter);
  return <main className="typewriter-shell">
    <canvas id="typewriter-canvas" />
    <StudioLink />
    <header className="typewriter-head">
      <p>Node Dojo portability lab</p>
      <h1>Procedural Typewriter</h1>
      <div id="typewriter-status">Loading portable graph…</div>
    </header>
    <aside className="typewriter-panel">
      <label><span>Text input</span><textarea id="typewriter-text" rows={5} defaultValue="NODE DOJO TYPEWRITER — now running entirely in the browser." /></label>
      <label><span>Animation frame</span><div className="typewriter-range"><input id="typewriter-frame" type="range" min="0" max="240" step="1" defaultValue="240" /><output id="typewriter-frame-output">240</output></div></label>
      <div className="typewriter-actions"><button id="typewriter-play" type="button">Play</button><button id="typewriter-evaluate" type="button">Evaluate</button></div>
      <section className="typewriter-stats"><span>Browser GN-VM</span><strong id="typewriter-count">—</strong><small id="typewriter-runtime">Web Worker</small></section>
      <div id="typewriter-font-status" className="typewriter-font-status loading">Pixels Medium TTF is required for the supplied type style. Loading supplied font…</div>
      <p className="typewriter-note">This page uses the supplied <code>pixels.ttf</code>. Its matching Blender-extracted outline atlas is embedded as the offline geometry fallback while preserving the authored Slice String, timing, wrapping, spacing, and Fill Curve graph.</p>
    </aside>
    <div className="typewriter-help">Drag to orbit · scroll to zoom</div>
  </main>;
}
