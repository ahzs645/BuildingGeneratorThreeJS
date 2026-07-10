import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./bin-studio.css";

const loadBinStudio = () => import("../../bin-studio");

export default function BinStudioPage(): React.JSX.Element {
  usePageRuntime("Dojo Bin Studio · interactive baked bin", loadBinStudio);
  return <><canvas id="app"></canvas><StudioLink /><div id="hud"><b>Dojo Bin Studio</b> · pre-baked from the .blend, 100% Blender fidelity · <span id="stat">loading…</span></div></>;
}
