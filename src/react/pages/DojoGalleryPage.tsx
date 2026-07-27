import { StudioLink } from "../StudioLink";
import { useToolRuntime } from "../page-runtime";
import "./dojo-gallery.css";

const loadGallery = () => import("../../dojo-gallery");

export default function DojoGalleryPage(): React.JSX.Element {
  useToolRuntime("Node Dojo Gallery · Blender Geometry Nodes in the browser", loadGallery);
  return (
    <main className="dojo-gallery-page">
      <canvas id="app"></canvas>
      <div className="top"><div className="eyebrow">Node Dojo → browser</div><h1 id="title">Gallery</h1><div id="subtitle">Blender-evaluated Geometry Nodes, presented as portable glTF.</div></div>
      <aside id="panel">
        <div id="models"></div>
        <div className="controls" aria-label="View style">
          <button type="button" data-style="original">original</button><button type="button" data-style="studio" className="active">studio</button><button type="button" data-style="wireframe">wire</button><button type="button" id="spin" className="active">spin</button><button type="button" id="reset">reset</button>
        </div>
      </aside>
      <div id="status">loading…</div>
      <StudioLink />
    </main>
  );
}
