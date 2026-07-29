import { useToolRuntime } from "../page-runtime";
import { StudioShell } from "../studio/StudioShell";
import "./bin-live.css";

const loadBinLive = () => import("../../bin-live");

/**
 * Blender-backed bin. bin-live.ts still builds its own lil-gui panel, so the
 * shell gives it a bare viewport plus the shared status bar; #stat and #busy
 * are the runtime's write targets.
 */
export default function BinLivePage(): React.JSX.Element {
  useToolRuntime("Dojo Bin — Live (Blender-backed)", loadBinLive);
  return <StudioShell
    className="bin-live-page"
    status={<>
      <span className="st-dot busy" />
      <span>Every slider re-bakes geometry in Blender</span>
      <span className="st-sep" />
      <span className="st-muted">Three.js material preview</span>
      <span className="st-spacer" />
      <span id="stat">connecting…</span>
    </>}
  >
    <canvas id="app"></canvas>
    <div id="busy">baking…</div>
  </StudioShell>;
}
