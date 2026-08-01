import { useEffect, useRef } from "react";
import { usePageRuntime } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import "./materialx-lab.css";

/**
 * mountMaterialXLab() resolves every control against the root it is handed, so
 * the shell body is that root: the canvas lives in the viewport column and the
 * selectors live in the inspector, but both sit inside the same element.
 */
export default function MaterialXLabPage(): React.JSX.Element {
  usePageRuntime("MaterialX shader parity lab");
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let disposed = false;
    let disposeLab: (() => void) | undefined;
    void import("../../materialx-lab").then(({ mountMaterialXLab }) => {
      if (disposed || !rootRef.current) return;
      disposeLab = mountMaterialXLab(rootRef.current);
    }).catch((error) => {
      if (disposed || !rootRef.current) return;
      const graphStatus = rootRef.current.querySelector<HTMLElement>("#materialx-graph");
      if (graphStatus) graphStatus.textContent = error instanceof Error ? error.message : String(error);
    });
    return () => {
      disposed = true;
      disposeLab?.();
    };
  }, []);
  // The capture harness pins the render to 768×768; ?capture also drops the
  // shell chrome through StudioChrome, so only the sizing is page-specific.
  const capture = new URLSearchParams(location.search).get("capture") === "1";
  const threeLabel = import.meta.env.VITE_MATERIALX_THREE_LABEL || "Three.js 0.185.1 baseline";

  const rightDock = <>
    <StudioPanelHeader title="Shader" />
    <div className="st-section">
      <div className="st-section-title">Blender → MaterialX → Web</div>
      <label className="st-field">
        <span>Backend</span>
        <select id="materialx-backend" className="st-select" defaultValue="materialx">
          <option value="materialx">MaterialX graph</option>
          <option value="baked-pbr">Baked PBR · Blender/Cycles</option>
          <option value="legacy-authored">Legacy authored fallback</option>
          <option value="normalized">Normalized diagnostic</option>
        </select>
      </label>
      <label className="st-field">
        <span>Variant</span>
        <select id="materialx-variant" className="st-select" defaultValue="bump">
          <option value="bump">Noise bump compatibility probe</option>
          <option value="source">chrome.003 native lowering</option>
        </select>
      </label>
      <p className="st-finding">An isolated node-material route. The existing WebGLRenderer and ShaderMaterial pages remain untouched.</p>
    </div>
    <div className="st-section">
      <div className="st-section-title">Preflight</div>
      <div className="materialx-row"><span>Renderer</span><b id="materialx-renderer">Initializing…</b></div>
      <div className="materialx-row"><span>Graph preflight</span><b id="materialx-graph">Loading portable graph…</b></div>
      <div className="materialx-row"><span>Resolution</span><b id="materialx-fallback">Pending…</b></div>
    </div>
    <div className="st-section">
      <div className="st-chip warn">
        <span id="materialx-source-finding">The supplied <code>chrome.003</code> graph contains Noise but no Wave or Bump. The bump view is a general pipeline probe, clearly separated from source-parity claims.</span>
      </div>
      <a className="materialx-provenance" href="https://github.com/mrdoob/three.js/pull/31439" target="_blank" rel="noreferrer">Three MaterialX / Blender alignment provenance ↗</a>
    </div>
  </>;

  return <StudioShell
    className={`materialx-lab ${capture ? "capture" : ""}`}
    bodyRef={rootRef}
    rightDock={rightDock}
    toolbar={<span>{threeLabel}</span>}
    status={<>
      <span className="st-dot busy" />
      <span id="materialx-status">Initializing isolated renderer…</span>
    </>}
  >
    <canvas id="materialx-canvas" aria-label="MaterialX shader comparison render" />
  </StudioShell>;
}
