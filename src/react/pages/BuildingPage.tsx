import { StudioLink } from "../StudioLink";
import { useToolRuntime } from "../page-runtime";
import "./building.css";

const loadBuilding = () => import("../../main");

export default function BuildingPage(): React.JSX.Element {
  useToolRuntime("Hong Kong Building Generator", loadBuilding);
  return <main className="building-page"><div id="app"></div><div id="bar-top" className="bar top"></div><div id="bar-bottom" className="bar bottom"></div><div id="loading">Loading asset kit…</div><div className="credit"><b>HK BUILDING STUDIO</b> · drag to orbit · scroll to zoom · tweak the panel to regenerate</div><StudioLink /></main>;
}
