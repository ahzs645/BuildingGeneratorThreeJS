import { StudioLink } from "../StudioLink";
import { useToolRuntime } from "../page-runtime";
import "./dojo-viewer.css";

const loadDojo = () => import("../../dojo-viewer");

export default function DojoViewerPage(): React.JSX.Element {
  useToolRuntime("Node Dojo → Web · Bin Generator", loadDojo);
  return <main className="dojo-viewer-page"><canvas id="app"></canvas><StudioLink /><div id="hud"><b>NODE DOJO → WEB</b> · dojo bin generator (baked from .blend) · drag to orbit · scroll to zoom</div><div id="err"></div></main>;
}
