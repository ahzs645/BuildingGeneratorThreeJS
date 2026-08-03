import { useState, type ReactNode } from "react";

/**
 * Category tint for a node card. The tones mirror the procedural painter's
 * lil-gui stack (`.paint-node-*` in surface-painter.css) so an inspector built
 * from React controls and one built by lil-gui read as the same component.
 */
export type StudioNodeTone =
  | "source"
  | "interaction"
  | "generator"
  | "simulation"
  | "render"
  | "animation";

type StudioNodeProps = {
  title: ReactNode;
  /** Short uppercase role tag — INPUT, LIVE, BRUSH, PLAYBACK … */
  badge: string;
  tone: StudioNodeTone;
  /** Collapsed on first render; the user owns the state afterwards. */
  defaultOpen?: boolean;
  /** Tooltip for the whole card, usually why the stage exists. */
  title2?: string;
  children: ReactNode;
};

/**
 * One stage of an inspector pipeline: a collapsible card with a category port
 * dot, a role badge, and a body of ordinary `.st-row` / `.st-field` controls.
 * Stack several inside a `.st-node-stack` to present a dock column as the
 * graph it drives rather than as a flat list of sliders.
 */
export function StudioNode({
  title,
  badge,
  tone,
  defaultOpen = true,
  title2,
  children,
}: StudioNodeProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={`st-node st-node-${tone} ${open ? "" : "closed"}`} title={title2}>
    <button
      type="button"
      className="st-node-head"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      <span className="st-node-name">{title}</span>
      <span className="st-node-badge" aria-hidden="true">{badge}</span>
    </button>
    <div className="st-node-body" hidden={!open}>{children}</div>
  </section>;
}
