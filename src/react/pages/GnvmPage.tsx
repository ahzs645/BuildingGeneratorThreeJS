import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./gnvm-viewer.css";

const loadGnvm = () => import("../../gnvm-viewer");

export default function GnvmPage(): React.JSX.Element {
  usePageRuntime("GN-VM · Live Geometry Nodes", loadGnvm);
  return <><canvas id="app"></canvas><StudioLink /><div id="hud"><b>GN-VM</b> · running the dumped .blend graph live in TypeScript · <span id="stat">loading…</span></div></>;
}
