import { StudioLink } from "../StudioLink";
import { useToolRuntime } from "../page-runtime";
import "./bin-live.css";

const loadBinLive = () => import("../../bin-live");

export default function BinLivePage(): React.JSX.Element {
  useToolRuntime("Dojo Bin — Live (Blender-backed)", loadBinLive);
  return <main className="bin-live-page"><canvas id="app"></canvas><StudioLink /><div id="busy">baking…</div><div id="hud"><b>Dojo Bin · Live</b> · every slider re-bakes geometry in Blender · Three.js material preview · <span id="stat">connecting…</span></div></main>;
}
