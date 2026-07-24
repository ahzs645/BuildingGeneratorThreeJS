import type { Dump } from "../../gnvm";
import { createPortal } from "react-dom";

export type GeometryNodesPreset = {
  id: string;
  name: string;
  description: string;
  badge: string;
  dump?: Dump;
  transform?: (dump: Dump) => void;
};

function graphStats(dump: Dump): { groups: number; nodes: number; links: number } {
  const groups = Object.values(dump.node_groups);
  return {
    groups: groups.length,
    nodes: groups.reduce((total, group) => total + group.nodes.length, 0),
    links: groups.reduce((total, group) => total + group.links.length, 0),
  };
}

export function GraphPresetLibrary({
  source,
  presets,
  onApply,
  onClose,
}: {
  source: Dump;
  presets: GeometryNodesPreset[];
  onApply: (preset: GeometryNodesPreset) => void;
  onClose: () => void;
}): React.JSX.Element {
  return createPortal(<div className="graph-library-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="graph-library" role="dialog" aria-modal="true" aria-label="Geometry Nodes preset library">
      <header>
        <div><span>Reusable graph library</span><h2>Geometry Nodes presets</h2></div>
        <button type="button" onClick={onClose}>×</button>
      </header>
      <p className="graph-library-intro">Every preset forks the checked-in portable graph into the current workspace. The source asset remains unchanged.</p>
      <div className="graph-library-grid">
        {presets.map((preset) => {
          const presetStats = graphStats(preset.dump ?? source);
          return <article key={preset.id}>
          <div className="graph-preset-preview" aria-hidden="true">
            <i /><i /><i /><i /><i />
            <svg viewBox="0 0 180 72"><path d="M25 22 C52 22 47 48 73 48 S95 20 122 20 S139 49 159 49" /></svg>
          </div>
          <div className="graph-preset-copy">
            <span>{preset.badge}</span>
            <h3>{preset.name}</h3>
            <p>{preset.description}</p>
            <small>{presetStats.groups} groups · {presetStats.nodes} nodes · {presetStats.links} links</small>
          </div>
          <button type="button" onClick={() => onApply(preset)}>Fork into workspace</button>
        </article>;
        })}
      </div>
    </section>
  </div>, document.body);
}
