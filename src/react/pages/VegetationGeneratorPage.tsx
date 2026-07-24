import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./vegetation-generator.css";

const loadVegetationGenerator = () => import("../../vegetation-generator/main");

export default function VegetationGeneratorPage(): React.JSX.Element {
  usePageRuntime("Vegetation Generator · three.js WebGPU", loadVegetationGenerator);

  return (
    <main className="vegetation-generator-page">
      <div id="vegetation-generator-app" />
      <div id="drawFrame" />
      <div id="vegetation-generator-title">
        <span aria-hidden="true">🌿</span> Vegetation Generator <small>three.js WebGPU</small>
      </div>
      <button id="modeBtn" type="button" aria-label="Toggle the active vegetation interaction mode">
        <span className="dot" />
        <span className="label">Draw mode</span>
        <span className="key">D</span>
      </button>
      <div id="hud" />
      <div id="toast" role="status" aria-live="polite" />
      <StudioLink />
    </main>
  );
}
