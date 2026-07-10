import { usePageRuntime } from "../page-runtime";
import { appHref } from "../../base-url";
import "./index.css";

const cards = [
  { href: "/blendbridge", tag: "Importer · Local", title: "BlendBridge", badge: "new", copy: "Drop in a Blender file. Extract its Geometry Nodes graph, inspect browser coverage, generate controls, run a worker-isolated preview, and export reusable graph JSON.", action: "Import a .blend" },
  { href: "/gallery", tag: "Node Dojo · Gallery", title: "More Node Dojo Studies", badge: "new", copy: "Chrome Crayon, Schoen Gyroid, Schwarz P-Surface, the procedural hat, and the recursive bin in one selectable browser viewer.", action: "Open gallery" },
  { href: "/building", tag: "Hand-ported", title: "Hong Kong Building", copy: "A 592-node build system reverse-engineered into a TypeScript placement algorithm. About 190 instanced parts and 18 live parameters.", action: "Open generator" },
  { href: "/bin", tag: "Path A · Bake", title: "Dojo Bin Studio", badge: "interactive", copy: "The complete Node Dojo bin with pre-baked variants at Blender fidelity and an interactive selected-bin control.", action: "Open studio" },
  { href: "/gnvm", tag: "Path B · Live VM", title: "Dojo Bin — Live VM", badge: "GN-VM", copy: "The same Blender graph executed by the browser Geometry Nodes interpreter with generated controls and live mesh rebuilds.", action: "Open live VM" },
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
