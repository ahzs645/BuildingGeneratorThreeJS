import { useEffect, useState } from "react";
import type { LibraryShapeInfo } from "../../../base-shape-catalog";
import {
  defaultChromeCrayonSettings,
  defaultPeriodicBrushSettings,
  defaultStampSettings,
  defaultTypewriterSettings,
  type ChromeCrayonSettings,
  type PeriodicBrushSettings,
  type StampSettings,
  type TypewriterSettings,
} from "../../../surface-studio/blender-gn-adapters";
import type { SurfaceGeneratorId } from "../../../surface-studio/contracts";
import type { SurfacePainterToolHandle } from "../../../surface-painter/main";
import { rangeFillStyle } from "../../studio/range-fill";

export interface BlenderBrushOptionsProps {
  tool: SurfaceGeneratorId;
  controller: SurfacePainterToolHandle;
  references: readonly LibraryShapeInfo[];
}

export function BlenderBrushOptions({ tool, controller, references }: BlenderBrushOptionsProps): React.JSX.Element {
  if (tool === "periodic-brush") return <PeriodicOptions controller={controller} />;
  if (tool === "typewriter") return <TypewriterOptions controller={controller} />;
  if (tool === "stamp") return <StampOptions controller={controller} references={references} />;
  return <ChromeOptions controller={controller} />;
}

function ChromeOptions({ controller }: { controller: SurfacePainterToolHandle }): React.JSX.Element {
  const [settings, setSettings] = useSettings(controller, "chrome-crayon", defaultChromeCrayonSettings);
  const update = <Key extends keyof ChromeCrayonSettings>(key: Key, value: ChromeCrayonSettings[Key]): void => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    void controller.setGeneratorSettings("chrome-crayon", next);
  };
  const applyPreset = (preset: "line" | "sigil"): void => {
    const next: ChromeCrayonSettings = preset === "sigil"
      ? {
          ...settings,
          thickness: 24.318,
          peakHeight: 404.742,
          sigilize: 665,
          soften: 3,
          resolution: 0.835,
          spiro: 3,
          extrudeBase: 1,
          flatten: false,
        }
      : { ...settings, ...defaultChromeCrayonSettings, color: settings.color };
    setSettings(next);
    void controller.setGeneratorSettings("chrome-crayon", next);
  };
  return <div className="st-section surface-adapter-options">
    <label className="surface-shared-field"><span>Chrome workflow</span><select className="st-select" value={settings.sigilize > 0 ? "sigil" : "line"} onChange={(event) => applyPreset(event.currentTarget.value as "line" | "sigil")}><option value="line">Drawn line · live GN-VM</option><option value="sigil">Unique projected sigil</option></select></label>
    <Range label="Thickness" min={0.6} max={30} step={0.1} value={settings.thickness} onChange={(value) => update("thickness", value)} />
    <Range label="Peak height" min={0.5} max={450} step={0.1} value={settings.peakHeight} onChange={(value) => update("peakHeight", value)} />
    <Range label="Sigilize" min={0} max={800} step={1} value={settings.sigilize} onChange={(value) => update("sigilize", value)} />
    <Range label="Edge smoothing" min={0} max={10} step={1} value={settings.soften} onChange={(value) => update("soften", value)} />
    <Range label="Resolution" min={0.2} max={1} step={0.005} value={settings.resolution} onChange={(value) => update("resolution", value)} />
    <Range label="SPIRO" min={0} max={3} step={1} value={settings.spiro} onChange={(value) => update("spiro", value)} />
    <Range label="Extrude" min={0.1} max={3} step={0.1} value={settings.extrudeBase} onChange={(value) => update("extrudeBase", value)} />
    <label className="st-row st-row-wide"><span>Flatten stroke</span><input type="checkbox" checked={settings.flatten} onChange={(event) => update("flatten", event.currentTarget.checked)} /></label>
    <button className="st-btn" type="button" onClick={() => applyPreset("sigil")}>Auto-connect into a unique sigil</button>
    <p className="surface-edit-hint">Sigil mode restores the Brush Lab workflow: it normalizes the drawn curves into one motif, evaluates the authored graph, then conforms the result to the shared projection target.</p>
  </div>;
}

function PeriodicOptions({ controller }: { controller: SurfacePainterToolHandle }): React.JSX.Element {
  const [settings, setSettings] = useSettings(controller, "periodic-brush", defaultPeriodicBrushSettings);
  const update = <Key extends keyof PeriodicBrushSettings>(key: Key, value: PeriodicBrushSettings[Key]): void => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    void controller.setGeneratorSettings("periodic-brush", next);
  };
  return <div className="st-section surface-adapter-options">
    <Range label="Spacing" min={0.12} max={1.2} step={0.01} value={settings.spacing} onChange={(value) => update("spacing", value)} />
    <Range label="Size" min={0.002} max={0.08} step={0.001} value={settings.size} onChange={(value) => update("size", value)} />
  </div>;
}

function TypewriterOptions({ controller }: { controller: SurfacePainterToolHandle }): React.JSX.Element {
  const [settings, setSettings] = useSettings(controller, "typewriter", defaultTypewriterSettings);
  const update = <Key extends keyof TypewriterSettings>(key: Key, value: TypewriterSettings[Key]): void => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    void controller.setGeneratorSettings("typewriter", next);
  };
  return <div className="st-section surface-adapter-options">
    <label className="st-row"><span>Text</span><input className="st-input" type="text" value={settings.text} onChange={(event) => update("text", event.currentTarget.value)} /></label>
    <label className="st-row"><span>Fit stroke</span><input type="checkbox" checked={settings.fitStroke} onChange={(event) => update("fitStroke", event.currentTarget.checked)} /></label>
    <Range label="Text size" min={0.08} max={1.2} step={0.01} value={settings.size} disabled={settings.fitStroke} onChange={(value) => update("size", value)} />
    <Range label="Offset" min={-1} max={1} step={0.02} value={settings.offset} onChange={(value) => update("offset", value)} />
    <p className="surface-edit-hint">Draw on the shared surface. The generated glyphs follow the same projected stroke document as every other projected brush.</p>
  </div>;
}

function StampOptions({ controller, references }: { controller: SurfacePainterToolHandle; references: readonly LibraryShapeInfo[] }): React.JSX.Element {
  const [settings, setSettings] = useSettings(controller, "stamp", defaultStampSettings);
  const update = <Key extends keyof StampSettings>(key: Key, value: StampSettings[Key]): void => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    void controller.setGeneratorSettings("stamp", next);
  };
  return <div className="st-section surface-adapter-options">
    <label className="surface-shared-field"><span>Stamp object</span><select className="st-select" value={settings.assetId} onChange={(event) => update("assetId", event.currentTarget.value)}><option value="">Choose a reference object…</option>{references.map((reference) => <option value={reference.id} key={reference.id}>{reference.title}</option>)}</select></label>
    <Range label="Stamp size" min={0.1} max={1.5} step={0.02} value={settings.size} onChange={(value) => update("size", value)} />
    <Range label="Spacing" min={0.15} max={2} step={0.05} value={settings.spacing} onChange={(value) => update("spacing", value)} />
    <p className="surface-edit-hint">The stamp object repeats along strokes already stored on the shared target.</p>
  </div>;
}

function useSettings<Settings>(
  controller: SurfacePainterToolHandle,
  tool: SurfaceGeneratorId,
  defaults: Readonly<Settings>,
): [Readonly<Settings>, (settings: Readonly<Settings>) => void] {
  const current = controller.settingsFor<Settings>(tool) ?? defaults;
  const [settings, setSettings] = useState<Readonly<Settings>>(() => ({ ...current }));
  useEffect(() => setSettings({ ...(controller.settingsFor<Settings>(tool) ?? defaults) }), [controller, defaults, tool]);
  return [settings, setSettings];
}

function Range({
  label,
  min,
  max,
  step,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return <label className="st-row"><span>{label}</span><input type="range" min={min} max={max} step={step} value={value} style={rangeFillStyle(value, min, max)} disabled={disabled} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} /><output>{step < 0.01 ? value.toFixed(3) : value.toFixed(step < 0.1 ? 2 : 1)}</output></label>;
}

export default BlenderBrushOptions;
