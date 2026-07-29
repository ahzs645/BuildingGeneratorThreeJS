import { useToolRuntime } from "../page-runtime";
import { StudioShell } from "../studio/StudioShell";
import "./dojo-gallery.css";

const loadGallery = () => import("../../dojo-gallery");

/**
 * Baked Blender exports. One dock, no inspector — the shell collapses the
 * fourth column to 0. #title / #subtitle / #models / #status stay because
 * dojo-gallery.ts writes into them by id.
 */
export default function DojoGalleryPage(): React.JSX.Element {
  useToolRuntime("Node Dojo Gallery · Blender Geometry Nodes in the browser", loadGallery);
  const leftDock = <>
    <div className="st-tabs"><button type="button" aria-selected="true">Models</button></div>
    <div className="st-section">
      {/* #title is the selected model; #subtitle rides in the toolbar. */}
      <div className="st-section-title"><span id="title">Gallery</span></div>
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
      status={<span id="status">loading…</span>}
    >
      <canvas id="app"></canvas>
    </StudioShell>
  );
}
