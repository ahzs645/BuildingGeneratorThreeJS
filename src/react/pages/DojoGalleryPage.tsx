import { useToolRuntime } from "../page-runtime";
import { StudioPanelHeader, StudioShell } from "../studio/StudioShell";
import { ToolStateOverlay } from "../studio/ToolStateOverlay";
import "./dojo-gallery.css";

const loadGallery = () => import("../../dojo-gallery");

/**
 * Baked Blender exports. One dock, no inspector — the shell collapses the
 * fourth column to 0. #title / #subtitle / #models / #status stay because
 * dojo-gallery.ts writes into them by id.
 */
export default function DojoGalleryPage(): React.JSX.Element {
  const runtimeState = useToolRuntime("Node Dojo Gallery · Blender Geometry Nodes in the browser", loadGallery);
  const leftDock = <>
    {/* #title is the selected model. It belongs in the panel header's meta
        slot, not in a section title: as a section title it rendered the
        selected model's name in uppercase meta styling directly above a list
        of all five, reading as a category header for a list it did not
        describe. #subtitle rides in the toolbar. */}
    <StudioPanelHeader title="Baked models" meta={<span id="title">GLB gallery</span>} />
    <div className="st-section">
      <div className="st-section-title">Models<small>5 bakes</small></div>
      <div id="models"></div>
    </div>
    <div className="st-section">
      <div className="st-section-title">View</div>
      <div className="st-segmented" aria-label="View style">
        {/* "original" is the runtime's initial viewStyle (dojo-gallery.ts). */}
        <button type="button" data-style="original" className="active">Original</button>
        <button type="button" data-style="studio">Studio</button>
        <button type="button" data-style="wireframe">Wire</button>
      </div>
      <div className="st-segmented">
        <button type="button" id="spin" className="active">Spin</button>
        <button type="button" id="reset">Reset view</button>
      </div>
    </div>
  </>;

  return (
    <StudioShell
      className="dojo-gallery-page"
      leftDock={leftDock}
      toolbar={<span id="subtitle">Blender-evaluated Geometry Nodes, presented as portable glTF.</span>}
      status={<span id="status" className="st-state busy">
        <span className="st-dot" />
        <span data-status-text>loading…</span>
      </span>}
    >
      <canvas id="app"></canvas>
      <ToolStateOverlay state={runtimeState} />
    </StudioShell>
  );
}
