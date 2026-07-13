import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./chrome-assets.css";

const loadChromeAssets = () => import("../../chrome-assets");

export default function ChromeAssetsPage(): React.JSX.Element {
  usePageRuntime("Chrome Asset Library · Blender vs browser", loadChromeAssets);
  return <main className="assets-shell">
    <StudioLink />
    <header className="assets-head"><p>Node Dojo coverage lab</p><h1>Chrome Asset Library</h1><div id="assets-status">Loading catalog…</div></header>
    <section className="assets-compare">
      <figure className="assets-pane"><figcaption><span>Blender reference</span><strong id="assets-blender-count">—</strong></figcaption><img id="assets-reference" alt="Isolated Blender reference render" /></figure>
      <figure className="assets-pane"><figcaption><span>Browser GN-VM</span><strong id="assets-vm-count">—</strong></figcaption><canvas id="assets-canvas" /></figure>
    </section>
    <aside className="assets-panel">
      <label><span>Ported asset</span><select id="assets-select" /></label>
      <div id="assets-font-status" hidden />
      <div id="assets-controls" />
      <button id="assets-reset" type="button">Reset authored values</button>
      <small id="assets-runtime">Worker idle</small>
    </aside>
  </main>;
}
