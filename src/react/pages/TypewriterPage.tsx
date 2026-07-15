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
      <label className="typewriter-font-file"><span>Original font preview</span><input id="typewriter-font-file" type="file" accept=".ttf,font/ttf" /></label>
      <div id="typewriter-font-status" className="typewriter-font-status loading">The original Blurmed.ttf is license-restricted. Exact extracted glyph geometry is embedded; choose your local recovered TTF to match the editor preview.</div>
      <p className="typewriter-note">Generated geometry currently uses a reusable Blender-extracted Blurmed outline atlas. The commercial binary is not distributed, but the outline atlas still requires license review; the supplied Pixels preview font also has unverified license provenance.</p>
    </aside>
    <div className="typewriter-help">Drag to orbit · scroll to zoom</div>
  </main>;
}
