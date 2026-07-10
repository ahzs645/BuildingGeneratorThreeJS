import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./bin-live.css";

const loadBinLive = () => import("../../bin-live");

export default function BinLivePage(): React.JSX.Element {
  usePageRuntime("Dojo Bin — Live (Blender-backed)", loadBinLive);
  return <><canvas id="app"></canvas><StudioLink /><div id="busy">baking…</div><div id="hud"><b>Dojo Bin · Live</b> · every slider re-bakes in Blender (100% fidelity) · <span id="stat">connecting…</span></div></>;
}
