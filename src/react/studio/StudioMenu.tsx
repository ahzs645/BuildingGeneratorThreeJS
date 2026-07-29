import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import "./studio-menu.css";

export type StudioTool = { href: string; title: string; desc: string; badge?: string };

/**
 * The rail's geometric marks. Pure CSS shapes — no icon assets, no icon
 * library — so a section is identifiable at 13px without a glyph font.
 */
export type StudioMark = "square" | "circle-outline" | "diamond" | "square-outline" | "dot";

export type StudioSection = {
  title: string;
  /** Short form for the nav section switcher and the tool rail. */
  label: string;
  mark: StudioMark;
  /** Draws the rail's `hr` above this section (the parity group). */
  railBreak?: boolean;
  items: StudioTool[];
};

// Every routed tool in the app. The studio workspace is the root route; the
// Dev section carries the experiments that were never on the old landing page.
// `label` + `mark` also drive the nav section switcher and the tool rail, so a
// new section appears in all three places at once.
export const STUDIO_TOOLS: StudioSection[] = [
  {
    title: "Studio",
    label: "Studio",
    mark: "square",
    items: [
      { href: "/", title: "Procedural Studio", badge: "asset library", desc: "Import a .blend or browse the ported asset library, inspect and edit its Geometry Nodes graph, evaluate it in the browser VM" },
    ],
  },
  {
    title: "Create",
    label: "Create",
    mark: "circle-outline",
    items: [
      { href: "/paint", title: "Surface Painting Studio", badge: "WebGPU", desc: "Paint ivy, a banyan tree, crystal, molten, aurora, or reef growth onto any model — or switch to the Blender brush lab and run authored brushes along your stroke" },
      { href: "/building", title: "Hong Kong Building", desc: "592-node build system hand-ported to TypeScript, 18 parameters" },
    ],
  },
  {
    title: "Node studies",
    label: "Studies",
    mark: "diamond",
    items: [
      { href: "/typewriter", title: "Procedural Typewriter", desc: "Editable text through the authored Typewriter graph, with animation playback — also loadable from the asset library" },
      { href: "/gallery", title: "Node Dojo Gallery", badge: "baked", desc: "Frozen Blender-evaluated GLB exports with their original materials — the live versions of these assets live in the asset library" },
    ],
  },
  {
    title: "Blender parity",
    label: "Parity",
    mark: "square-outline",
    railBreak: true,
    items: [
      { href: "/chrome-assets", title: "Live Asset Library", badge: "102 assets", desc: "Blender reference renders beside live VM output · every asset also loads into the Studio" },
      { href: "/bin", title: "Dojo Bin Compare", desc: "Deep parity workspace for the recursive bin — the same graph as the studio's included sample" },
      { href: "/vase", title: "Bubble Vase Compare", desc: "Overlay and side-by-side parity for the bubble vase" },
      { href: "/materialx", title: "MaterialX Parity Lab", badge: "prototype", desc: "Capability-gated Blender → MaterialX shader experiment" },
    ],
  },
  {
    title: "Dev",
    label: "Dev",
    mark: "dot",
    items: [
      { href: "/crayon", title: "Chrome Crayon Compare", desc: "Single-asset parity workspace with the Blender-style graph" },
      { href: "/bin/live", title: "Bin Live", desc: "Live-evaluated recursive bin (needs the local bake bridge)" },
    ],
  },
];

type DevPreset = { label: string; href: string };
type DevPresetGroup = { tool: string; presets: DevPreset[] };

// Query-param test modes the tools understand but never link to. Preset
// clicks remount the target runtime even when it is the current tool
// (useToolRuntime depends on the router search string).
const DEV_PRESETS: DevPresetGroup[] = [
  {
    tool: "Surface painting",
    presets: [
      { label: "ivy", href: "/paint?mode=ivy" },
      { label: "banyan tree", href: "/paint?mode=tree" },
      { label: "crystals", href: "/paint?mode=crystals" },
      { label: "molten fissures", href: "/paint?mode=fissures" },
      { label: "aurora silk", href: "/paint?mode=aurora" },
      { label: "reef", href: "/paint?mode=reef" },
      { label: "blender brush lab", href: "/paint?engine=blender" },
    ],
  },
  {
    tool: "Bubble Vase",
    presets: [
      { label: "side by side", href: "/vase?view=side-by-side" },
      { label: "VM solid", href: "/vase?solid=1" },
      { label: "VM only", href: "/vase?only=vm" },
      { label: "Blender only", href: "/vase?only=truth" },
    ],
  },
  {
    tool: "Dojo Bin",
    presets: [0, 3, 6, 11].map((n) => ({ label: `select ${n}`, href: `/bin?select=${n}` })),
  },
  {
    tool: "Gallery",
    presets: [
      { label: "chrome crayon", href: "/gallery?model=chrome-crayon" },
      { label: "schoen gyroid", href: "/gallery?model=shoen-gyroid" },
      { label: "schwarz p", href: "/gallery?model=schwarz-p" },
      { label: "hat", href: "/gallery?model=hat-front" },
      { label: "bin", href: "/gallery?model=dojo-bin" },
    ],
  },
  {
    tool: "Asset Library captures",
    presets: [
      { label: "authored", href: "/chrome-assets?capture=authored" },
      { label: "materialx native", href: "/chrome-assets?capture=materialx-native" },
      { label: "materialx prefilter", href: "/chrome-assets?capture=materialx-prefilter" },
      { label: "stippler shader", href: "/chrome-assets?asset=img-pixel-stippler&capture=stippler-shader" },
      { label: "stippler debug", href: "/chrome-assets?asset=img-pixel-stippler&debug=threshold" },
    ],
  },
];

// Local pipelines that cannot run in the browser — documentation-in-place.
const CLI_REFERENCE: { cmd: string; desc: string }[] = [
  { cmd: "npm test", desc: "GN-VM + pipeline unit tests (tsx --test)" },
  { cmd: "node tools/bake-bridge.mjs", desc: "local Blender bake bridge on :7801 — powers Bin Live" },
  { cmd: "npm run dev", desc: "dev server incl. /api/blend-import extraction middleware" },
  { cmd: "npm run materialx:extract", desc: "extract Blender material → MaterialX document" },
  { cmd: "npm run materialx:capture:web", desc: "headless captures of the web viewers for parity evidence" },
  { cmd: "npm run materialx:compare", desc: "compare Blender renders against captured web output" },
];

type ProbeState = "checking" | "ok" | "down";

function probeDot(state: ProbeState): string {
  return state === "checking" ? "…" : state === "ok" ? "●" : "○";
}

function useDevStatus(enabled: boolean): { webgpu: ProbeState; bridge: ProbeState; importer: ProbeState } {
  const [webgpu, setWebgpu] = useState<ProbeState>("checking");
  const [bridge, setBridge] = useState<ProbeState>("checking");
  const [importer, setImporter] = useState<ProbeState>("checking");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) setWebgpu("down");
    else gpu.requestAdapter().then(
      (adapter) => { if (!cancelled) setWebgpu(adapter ? "ok" : "down"); },
      () => { if (!cancelled) setWebgpu("down"); },
    );
    const probe = (url: string, set: (s: ProbeState) => void): void => {
      fetch(url, { signal: AbortSignal.timeout(2500) }).then(
        (response) => { if (!cancelled) set(response.ok ? "ok" : "down"); },
        () => { if (!cancelled) set("down"); },
      );
    };
    probe("http://localhost:7801/status", setBridge);
    probe("/api/blend-import/health", setImporter);
    return () => { cancelled = true; };
  }, [enabled]);
  return { webgpu, bridge, importer };
}

function DevPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const status = useDevStatus(open);
  return (
    <div className="studio-menu-dev">
      <button type="button" className="studio-menu-dev-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> Presets, status &amp; pipelines
      </button>
      {open && <div className="studio-menu-dev-body">
        <div className="studio-menu-status" role="status">
          <span title="WebGPU adapter (vegetation + geometry painter)">{probeDot(status.webgpu)} WebGPU</span>
          <span title="Blender bake bridge on localhost:7801 (Bin Live)">{probeDot(status.bridge)} bake bridge :7801</span>
          <span title="/api/blend-import middleware (BlendBridge extraction, dev server only)">{probeDot(status.importer)} .blend importer</span>
        </div>
        {DEV_PRESETS.map((group) => (
          <div className="studio-menu-presets" key={group.tool}>
            <span>{group.tool}</span>
            <div>
              {group.presets.map((preset) => (
                <Link key={preset.href} to={preset.href} onClick={onClose}>{preset.label}</Link>
              ))}
            </div>
          </div>
        ))}
        <div className="studio-menu-cli">
          <span>Local pipelines (terminal)</span>
          {CLI_REFERENCE.map((entry) => (
            <div key={entry.cmd}><code>{entry.cmd}</code> {entry.desc}</div>
          ))}
        </div>
      </div>}
    </div>
  );
}

export function StudioMenu({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  // Portaled to <body>: the trigger lives inside .st-shell, a fixed-position
  // grid that would otherwise become the containing block for this fixed
  // overlay and clip it to the nav row.
  return createPortal(
    <div className="studio-menu-backdrop" onClick={onClose} role="presentation">
      <nav className="studio-menu" aria-label="Studio tools" onClick={(event) => event.stopPropagation()}>
        <header>
          <b>Procedural Studio</b>
          <span><kbd>⌘K</kbd> toggle · <kbd>Esc</kbd> close</span>
        </header>
        {STUDIO_TOOLS.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            <div className="studio-menu-items">
              {section.items.map((tool) => {
                const current = pathname === tool.href;
                return (
                  <Link key={tool.href} to={tool.href} onClick={onClose} className={current ? "current" : ""} aria-current={current ? "page" : undefined}>
                    <b>{tool.title}{tool.badge && <em>{tool.badge}</em>}</b>
                    <small>{tool.desc}</small>
                  </Link>
                );
              })}
            </div>
            {section.title === "Dev" && <DevPanel onClose={onClose} />}
          </section>
        ))}
      </nav>
    </div>,
    document.body,
  );
}

/** Locate the section + tool entry that owns a router pathname. */
export function findStudioTool(pathname: string): { section: StudioSection; tool: StudioTool } | null {
  for (const section of STUDIO_TOOLS) {
    const tool = section.items.find((item) => item.href === pathname);
    if (tool) return { section, tool };
  }
  return null;
}
