import { usePageRuntime } from "../page-runtime";
import { appHref } from "../../base-url";
import "./blend-import.css";

const loadBlendBridge = () => import("../../blend-import");

export default function BlendBridgePage(): React.JSX.Element {
  usePageRuntime("BlendBridge · Blender nodes to browser", loadBlendBridge);
  return (
    <div className="shell">
      <header>
        <div className="brand"><span className="brand-mark">B</span><span>BlendBridge <small>local</small></span></div><div className="crumb"></div><h1>Geometry Nodes → browser runtime</h1>
        <div className="header-actions"><div id="health" className="health"><span className="health-dot"></span><span>checking Blender…</span></div><a className="ghost-link" href={appHref()}>Studio home</a></div>
      </header>
      <main>
        <aside className="left">
          <div id="import-progress" className="progress"></div>
          <section className="section"><p className="eyebrow">01 · Source</p><h2>Bring your node graph</h2><p>Drop a Blender file to extract its objects, Geometry Nodes groups, materials and exposed controls.</p>
            <label id="dropzone" className="dropzone" htmlFor="file-input" tabIndex={0}><span className="drop-icon">↓</span><span><strong>Drop a .blend here</strong><span>or reuse an extracted .json · up to 1 GB</span></span></label>
            <input id="file-input" type="file" accept=".blend,.json,application/json" /><button id="sample-button" className="button" type="button">Try the bin sample</button>
            <div id="source-card" className="source-card"><span id="file-badge" className="file-badge">BLEND</span><span className="source-copy"><strong id="source-name">—</strong><span id="source-meta">—</span></span></div><div className="notice">Files stay on this machine. The server deletes its temporary copy after extraction.</div>
          </section>
          <section className="section"><p className="eyebrow">02 · Entry point</p><label className="field-label" htmlFor="object-select">Geometry Nodes object</label><select id="object-select" disabled><option>Import a file first</option></select><div className="button-row"><button id="preview-button" className="button primary" disabled>Build preview</button><button id="cancel-button" className="button danger" disabled>Stop</button></div><div className="button-row"><button id="export-dump" className="button" disabled>Export graph JSON</button><button id="export-mesh" className="button" disabled>Export mesh JSON</button></div></section>
          <section className="section"><p className="eyebrow">Graph inventory</p><div className="summary-grid"><div className="metric"><strong id="metric-objects">—</strong><span>GN objects</span></div><div className="metric"><strong id="metric-groups">—</strong><span>node groups</span></div><div className="metric"><strong id="metric-nodes">—</strong><span>nodes</span></div><div className="metric"><strong id="metric-materials">—</strong><span>materials</span></div></div><div id="compat" className="compat" hidden><span id="compat-score" className="compat-score">—</span><span className="compat-copy"><strong>selected-output coverage</strong><span id="compat-detail">reachable from this object</span></span></div></section>
        </aside>
        <section className="stage"><canvas id="preview"></canvas><div id="empty-state" className="empty-state"><div className="empty-card"><div className="empty-orbit"></div><h2>Your graph becomes an interface.</h2><p>Import a Blender file, choose a Geometry Nodes object, then build a live browser preview with editable group inputs.</p></div></div><div className="stage-toolbar"><span id="stage-object" className="stage-chip">No object selected</span><span id="stage-mode" className="stage-chip">Z-up source</span></div><div id="stage-status" className="stage-status">Waiting for a Blender graph</div></section>
        <aside className="right"><div className="right-header"><div className="tabs"><button className="tab active" data-tab="controls">Controls</button><button className="tab" data-tab="nodes">Node graph</button></div></div><div id="panel-controls" className="tab-panel active"><section className="section"><p className="eyebrow">Exposed inputs</p><h2>Parameters</h2><p id="parameter-intro">Select an object to generate controls from its modifier interface.</p><div id="parameters"></div></section><section className="section"><p className="eyebrow">Runtime notes</p><p>Evaluation runs outside the page. Stop and change the graph if a custom node group is too expensive or unsupported.</p></section></div><div id="panel-nodes" className="tab-panel"><section className="section"><p className="eyebrow">Extracted tree</p><h2>Groups &amp; nodes</h2><input id="node-search" className="text-input" placeholder="Filter nodes…" /><div id="unsupported" className="unsupported-list"></div><div id="groups" style={{ marginTop: 12 }}></div></section></div></aside>
      </main>
    </div>
  );
}
