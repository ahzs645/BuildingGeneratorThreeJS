import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { appHref } from "../../base-url";
import "./studio-menu.css";

type Tool = { href: string; title: string; desc: string; badge?: string };
type Section = { title: string; items: Tool[] };

// Every routed tool in the app. The studio workspace is the root route; the
// Dev section carries the experiments that were never on the old landing page.
export const STUDIO_TOOLS: Section[] = [
  {
    title: "Studio",
    items: [
      { href: "/", title: "Procedural Studio", desc: "Import a .blend, inspect and edit its Geometry Nodes graph, evaluate it in the browser VM" },
    ],
  },
  {
    title: "Create",
    items: [
      { href: "/vegetation-generator", title: "Vegetation Generator", badge: "WebGPU", desc: "Paint ivy or grow a banyan tree with live procedural controls" },
      { href: "/geometry-painter", title: "Geometry Painter", badge: "WebGPU", desc: "Paint crystal, molten, aurora, and reef growth onto a sphere" },
      { href: "/surface-draw", title: "Draw on a Model", desc: "Upload a mesh and run a Blender-authored brush along your stroke" },
      { href: "/building", title: "Hong Kong Building", desc: "592-node build system hand-ported to TypeScript, 18 parameters" },
    ],
  },
  {
    title: "Node studies",
    items: [
      { href: "/typewriter", title: "Procedural Typewriter", desc: "Editable text through the authored Typewriter graph" },
      { href: "/gallery", title: "Node Dojo Gallery", desc: "Crayon, gyroid, P-surface, hat, and bin in one viewer" },
    ],
  },
  {
    title: "Blender parity",
    items: [
      { href: "/chrome-assets", title: "Live Asset Library", badge: "101 assets", desc: "Blender reference renders beside live VM output" },
      { href: "/bin", title: "Dojo Bin Compare", desc: "Synchronized Blender truth and browser VM workspace" },
      { href: "/vase", title: "Bubble Vase Compare", desc: "Overlay and side-by-side parity for the bubble vase" },
      { href: "/materialx", title: "MaterialX Parity Lab", badge: "prototype", desc: "Capability-gated Blender → MaterialX shader experiment" },
    ],
  },
  {
    title: "Dev",
    items: [
      { href: "/crayon", title: "Chrome Crayon Compare", desc: "Single-asset parity workspace with the Blender-style graph" },
      { href: "/dojo", title: "Dojo Viewer", desc: "Single Node Dojo study viewer" },
      { href: "/bin/live", title: "Bin Live", desc: "Live-evaluated recursive bin" },
      { href: "/periodic-brush", title: "Periodic Brush", desc: "Periodic surface brush experiment" },
    ],
  },
];

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
  // Portaled to <body>: triggers live inside fixed, backdrop-filtered chrome
  // (e.g. .studio-brand), which would otherwise become the containing block
  // for this fixed overlay and collapse it into the header box.
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
                  <a key={tool.href} href={appHref(tool.href)} className={current ? "current" : ""} aria-current={current ? "page" : undefined}>
                    <b>{tool.title}{tool.badge && <em>{tool.badge}</em>}</b>
                    <small>{tool.desc}</small>
                  </a>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </div>,
    document.body,
  );
}

type StudioMenuButtonProps = {
  id?: string;
  className?: string;
  title?: string;
  children: ReactNode;
};

export function StudioMenuButton({ id, className, title, children }: StudioMenuButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button type="button" id={id} className={className} title={title ?? "Studio tools (⌘K)"} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {children}
      </button>
      <StudioMenu open={open} onClose={() => setOpen(false)} />
    </>
  );
}
