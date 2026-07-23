import { useEffect, useRef } from "react";
import { StudioLink } from "../StudioLink";
import { usePageRuntime } from "../page-runtime";
import "./materialx-lab.css";

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
  const capture = new URLSearchParams(location.search).get("capture") === "1";
  const threeLabel = import.meta.env.VITE_MATERIALX_THREE_LABEL || "Three.js 0.185.1 baseline";
  return <main ref={rootRef} className={`materialx-lab ${capture ? "capture" : ""}`}>
    {!capture && <StudioLink />}
    <section className="materialx-viewport">
      <canvas id="materialx-canvas" aria-label="MaterialX shader comparison render" />
      <div className="materialx-label"><span>{threeLabel}</span><strong id="materialx-status">Initializing isolated renderer…</strong></div>
    </section>
    <aside className="materialx-panel">
      <p className="materialx-eyebrow">Blender → MaterialX → Web</p>
      <h1>Shader parity lab</h1>
      <p className="materialx-summary">An isolated node-material route. Existing WebGLRenderer and ShaderMaterial pages remain untouched.</p>
      <label><span>Requested backend</span><select id="materialx-backend" defaultValue="materialx">
        <option value="materialx">MaterialX graph</option>
        <option value="baked-pbr">Baked PBR · Blender/Cycles</option>
        <option value="legacy-authored">Legacy authored fallback</option>
        <option value="normalized">Normalized diagnostic</option>
      </select></label>
      <label><span>Graph variant</span><select id="materialx-variant" defaultValue="bump">
        <option value="bump">Noise bump compatibility probe</option>
        <option value="source">chrome.003 native lowering</option>
      </select></label>
      <dl>
        <div><dt>Renderer</dt><dd id="materialx-renderer">Initializing…</dd></div>
        <div><dt>Graph preflight</dt><dd id="materialx-graph">Loading portable graph…</dd></div>
        <div><dt>Resolution</dt><dd id="materialx-fallback">Pending…</dd></div>
      </dl>
      <div className="materialx-warning"><b>Source finding</b><span>The supplied <code>chrome.003</code> graph contains Noise but no Wave or Bump. The bump view is a general pipeline probe, clearly separated from source-parity claims.</span></div>
      <a href="https://github.com/mrdoob/three.js/pull/31439" target="_blank" rel="noreferrer">Three MaterialX / Blender alignment provenance ↗</a>
    </aside>
  </main>;
}
