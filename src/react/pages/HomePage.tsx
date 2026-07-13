import { usePageRuntime } from "../page-runtime";
import { appHref } from "../../base-url";
import "./index.css";

const cards = [
  { href: "/surface-draw", tag: "Surface Lab · Upload", title: "Draw on a Model", badge: "new", copy: "Upload a GLB, OBJ, or STL, raycast an editable stroke onto its surface, and evaluate a Blender-authored brush through the browser GN-VM.", action: "Open surface lab" },
  { href: "/blendbridge", tag: "Importer · Local", title: "BlendBridge", badge: "new", copy: "Drop in a Blender file. Extract its Geometry Nodes graph, inspect browser coverage, generate controls, run a worker-isolated preview, and export reusable graph JSON.", action: "Import a .blend" },
  { href: "/gallery", tag: "Node Dojo · Gallery", title: "More Node Dojo Studies", badge: "new", copy: "Chrome Crayon, Schoen Gyroid, Schwarz P-Surface, the procedural hat, and the recursive bin in one selectable browser viewer.", action: "Open gallery" },
  { href: "/typewriter", tag: "Node Dojo · Live", title: "Procedural Typewriter", badge: "new", copy: "The authored Typewriter Geometry Nodes graph with editable text, frame-by-frame Slice String animation, spacing, wrapping, and portable vector glyphs.", action: "Open typewriter" },
  { href: "/chrome-assets", tag: "Node Dojo Assets · Blender ↔ Web", title: "Live Asset Library", badge: "40 assets", copy: "Isolated Blender reference renders beside live GN-VM output. Forty extracted Chrome and N03D assets now run with authored controls and measured Blender parity.", action: "Compare assets" },
  { href: "/building", tag: "Hand-ported", title: "Hong Kong Building", copy: "A 592-node build system reverse-engineered into a TypeScript placement algorithm. About 190 instanced parts and 18 live parameters.", action: "Open generator" },
  { href: "/bin", tag: "Blender ↔ GN-VM", title: "Dojo Bin Compare", badge: "interactive", copy: "One synchronized workspace for Blender truth and the browser VM. Change Bin Select, overlay both meshes, inspect material counts, or separate them side by side.", action: "Compare both" },
  { href: "/vase", tag: "Path B · Parity", title: "Bubble Vase Compare", copy: "Blender truth overlaid on the GN-VM result, with wireframe, solid, overlay, and side-by-side comparison controls.", action: "Open compare" },
] as const;

export default function HomePage(): React.JSX.Element {
  usePageRuntime("Procedural Studio · Blender Geometry Nodes on the web");
  return (
    <main className="wrap">
      <div className="eyebrow">Procedural Studio · React</div>
      <h1>Blender Geometry Nodes,<br /><span className="grad">running on the web.</span></h1>
      <p className="lede">One Vite + React application for the complete pipeline: local Blender graph extraction, portable glTF bakes, and a from-scratch <b>Geometry Nodes VM</b> running directly in TypeScript.</p>
      <nav className="grid" aria-label="Procedural tools">
        {cards.map((card) => (
          <a className="card" href={appHref(card.href)} key={card.href}>
            <span className="tag">{card.tag}</span>
            <h2>{card.title} {"badge" in card && <span className="badge">{card.badge}</span>}</h2>
            <p>{card.copy}</p>
            <span className="go">{card.action}</span>
          </a>
        ))}
      </nav>
      <footer className="footer"><span className="badge">single app</span> &nbsp; React owns routing and page composition; isolated Three.js runtimes own each procedural viewport.</footer>
    </main>
  );
}
