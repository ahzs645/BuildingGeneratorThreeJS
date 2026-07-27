import { usePageRuntime } from "../page-runtime";
import { appHref } from "../../base-url";
import "./index.css";

interface Card {
  href: string;
  title: string;
  badge?: string;
  copy: string;
  action: string;
}

interface Section {
  id: string;
  title: string;
  blurb: string;
  cards: Card[];
}

const sections: Section[] = [
  {
    id: "create",
    title: "Create",
    blurb: "Interactive tools — paint, grow, and generate procedural geometry live in the browser.",
    cards: [
      { href: "/vegetation-generator", title: "Vegetation Generator", badge: "WebGPU", copy: "Paint wind-reactive ivy onto a surface or grow an interactive banyan tree, then brush flowers and figs into bloom with live procedural controls.", action: "Open generator" },
      { href: "/geometry-painter", title: "Geometry Painter", badge: "WebGPU", copy: "Paint crystal veins, molten fissures, aurora silk, and bioluminescent reef colonies onto a floating sphere, with live growth and lighting controls.", action: "Open painter" },
      { href: "/surface-draw", title: "Draw on a Model", copy: "Upload a GLB, OBJ, or STL, draw an editable stroke onto its surface, and evaluate a Blender-authored brush through the browser VM.", action: "Open surface lab" },
      { href: "/building", title: "Hong Kong Building", copy: "A 592-node Blender build system hand-ported to a TypeScript placement algorithm — about 190 instanced parts and 18 live parameters.", action: "Open generator" },
    ],
  },
  {
    id: "vm",
    title: "Geometry Nodes VM",
    blurb: "Blender node graphs evaluated from scratch in TypeScript — import your own or explore the authored studies.",
    cards: [
      { href: "/blendbridge", title: "BlendBridge", copy: "Drop in a .blend file: extract its Geometry Nodes graph, inspect browser coverage, generate controls, preview it in a worker, and export reusable graph JSON.", action: "Import a .blend" },
      { href: "/typewriter", title: "Procedural Typewriter", copy: "The authored Typewriter graph with editable text, frame-by-frame Slice String animation, spacing, wrapping, and portable vector glyphs.", action: "Open typewriter" },
      { href: "/gallery", title: "Node Dojo Gallery", copy: "Chrome Crayon, Schoen Gyroid, Schwarz P-Surface, the procedural hat, and the recursive bin in one selectable browser viewer.", action: "Open gallery" },
    ],
  },
  {
    id: "parity",
    title: "Blender Parity",
    blurb: "Blender ground truth rendered next to live browser VM output, so drift is visible instead of assumed.",
    cards: [
      { href: "/chrome-assets", title: "Live Asset Library", badge: "101 assets", copy: "Isolated Blender reference renders beside live VM output for 101 extracted assets, with measured geometry parity; shader coverage varies by asset.", action: "Compare assets" },
      { href: "/bin", title: "Dojo Bin Compare", copy: "One synchronized workspace for Blender truth and the browser VM. Change Bin Select, overlay both meshes, inspect material counts, or view them side by side.", action: "Compare both" },
      { href: "/vase", title: "Bubble Vase Compare", copy: "Blender truth overlaid on the browser VM result, with wireframe, solid, overlay, and side-by-side comparison controls.", action: "Open compare" },
      { href: "/materialx", title: "MaterialX Parity Lab", badge: "prototype", copy: "A capability-gated Blender 5.1 → MaterialX shader experiment. Unsupported graph semantics fall back explicitly, without touching the production viewers.", action: "Open shader lab" },
    ],
  },
];

export default function HomePage(): React.JSX.Element {
  usePageRuntime("Procedural Studio · Blender Geometry Nodes on the web");
  return (
    <main className="wrap">
      <div className="eyebrow">Procedural Studio · React</div>
      <h1>Blender Geometry Nodes,<br /><span className="grad">running on the web.</span></h1>
      <p className="lede">One Vite + React application for the complete pipeline: local Blender graph extraction, portable glTF bakes, and a from-scratch <b>Geometry Nodes VM</b> running directly in TypeScript.</p>
      {sections.map((section) => (
        <section className="section" key={section.id} aria-labelledby={`section-${section.id}`}>
          <header className="section-head">
            <h2 id={`section-${section.id}`}>{section.title}</h2>
            <p>{section.blurb}</p>
          </header>
          <nav className="grid" aria-label={section.title}>
            {section.cards.map((card) => (
              <a className="card" href={appHref(card.href)} key={card.href}>
                <h3>{card.title} {card.badge && <span className="badge">{card.badge}</span>}</h3>
                <p>{card.copy}</p>
                <span className="go">{card.action}</span>
              </a>
            ))}
          </nav>
        </section>
      ))}
      <footer className="footer"><span className="badge">single app</span> &nbsp; React owns routing and page composition; isolated Three.js runtimes own each procedural viewport.</footer>
    </main>
  );
}
