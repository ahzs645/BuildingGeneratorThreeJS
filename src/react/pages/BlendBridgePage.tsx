import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isStaticDeploy, publicUrl } from "../../base-url";
import type { Dump } from "../../gnvm";
import {
  compatibilityForBlendStudioTarget,
  controlsForBlendStudioTarget,
  discoverBlendStudioTargets,
  seedableObjectNames,
  type BlendStudioSeed,
} from "../../blend-studio/model";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import { useBlendStudioRuntime } from "../blend-studio/useBlendStudioRuntime";
import { usePageRuntime } from "../page-runtime";
import { FloatingStudioPanel, StudioShell, type StudioPanelRect } from "../studio/StudioShell";
import "./crayon-compare.css";
import "./blend-studio.css";

type ImportedDump = Dump & {
  import_meta?: {
    filename?: string;
    bytes?: number;
    blender_version?: string;
    extracted_at?: string;
    transient?: boolean;
  };
};

type Health = {
  available: boolean;
  executable?: string;
  max_upload_bytes?: number;
};

const editorConfig = {
  dumpUrl: "",
  events: {
    change: "blend-studio-graph-change",
    nodeSelect: "blend-studio-node-select",
    resize: "blend-studio-graph-resize",
  },
  storageKey: "blend-studio-gnvm-draft",
  downloadFileName: "blend-studio-edited.json",
} as const;

const UI_STORAGE_KEY = "procedural-studio.blendbridge.ui";

function defaultGraphRect(): StudioPanelRect {
  const width = Math.min(1120, Math.max(640, window.innerWidth - 650));
  const height = Math.min(620, Math.max(420, window.innerHeight - 180));
  return {
    x: Math.max(304, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(92, window.innerHeight - height - 28),
    width,
    height,
  };
}

function initialGraphRect(): StudioPanelRect {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) ?? "{}") as {
      graphRect?: Partial<StudioPanelRect>;
    };
    const rect = saved.graphRect;
    if (
      rect
      && [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value))
      && Number(rect.width) >= 480
      && Number(rect.height) >= 320
    ) return rect as StudioPanelRect;
  } catch {
    // UI persistence is optional.
  }
  return defaultGraphRect();
}

function humanBytes(value = 0): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

function download(name: string, value: BlobPart): void {
  const url = URL.createObjectURL(new Blob([value], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function seedFromValue(value: string): BlendStudioSeed {
  return value.startsWith("object:")
    ? { kind: "object", objectName: value.slice("object:".length) }
    : { kind: value as Exclude<BlendStudioSeed["kind"], "object"> };
}

export default function BlendBridgePage(): React.JSX.Element {
  usePageRuntime("BlendBridge · Geometry Nodes import studio");
  const fileInput = useRef<HTMLInputElement>(null);
  const importSerial = useRef(0);
  const [docksOpen, setDocksOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const [graphRect, setGraphRect] = useState(initialGraphRect);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importMessage, setImportMessage] = useState("Drop a Blender file or load the included sample");
  const [sourceDump, setSourceDump] = useState<ImportedDump | null>(null);
  const [workingDump, setWorkingDump] = useState<Dump | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceBytes, setSourceBytes] = useState(0);
  const [sourceKey, setSourceKey] = useState("");
  const [targetId, setTargetId] = useState("");
  const [overrides, setOverrides] = useState<Record<string, number | boolean>>({});
  const [seedValue, setSeedValue] = useState("cube");
  const [geometryInput, setGeometryInput] = useState("");
  const [geometryOutput, setGeometryOutput] = useState("");
  const runtime = useBlendStudioRuntime();

  useEffect(() => {
    if (isStaticDeploy) {
      setHealth({ available: false });
      return;
    }
    const controller = new AbortController();
    fetch("/api/blend-import/health", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((value: Health) => setHealth(value))
      .catch(() => setHealth({ available: false }));
    return () => controller.abort();
  }, []);

  const targets = useMemo(
    () => workingDump ? discoverBlendStudioTargets(workingDump) : [],
    [workingDump],
  );
  const target = useMemo(
    () => targets.find((candidate) => candidate.id === targetId) ?? targets[0] ?? null,
    [targetId, targets],
  );
  const controls = useMemo(
    () => workingDump && target ? controlsForBlendStudioTarget(workingDump, target) : [],
    [target, workingDump],
  );
  const compatibility = useMemo(
    () => workingDump && target ? compatibilityForBlendStudioTarget(workingDump, target) : null,
    [target, workingDump],
  );
  const seedObjects = useMemo(
    () => workingDump ? seedableObjectNames(workingDump) : [],
    [workingDump],
  );
  const geometryInputs = useMemo(
    () => workingDump && target
      ? workingDump.node_groups[target.groupName]?.interface.filter((item) =>
          item.item_type === "SOCKET"
          && item.in_out === "INPUT"
          && item.socket_type === "NodeSocketGeometry"
          && item.identifier)
      : [],
    [target, workingDump],
  );
  const geometryOutputs = useMemo(
    () => workingDump && target
      ? workingDump.node_groups[target.groupName]?.interface.filter((item) =>
          item.item_type === "SOCKET"
          && item.in_out === "OUTPUT"
          && item.socket_type === "NodeSocketGeometry"
          && item.identifier)
      : [],
    [target, workingDump],
  );
  const inventory = useMemo(() => {
    if (!workingDump) return { objects: 0, groups: 0, nodes: 0, materials: 0 };
    return {
      objects: targets.filter((item) => item.kind === "object").length,
      groups: Object.keys(workingDump.node_groups).length,
      nodes: Object.values(workingDump.node_groups).reduce((sum, group) => sum + group.nodes.length, 0),
      materials: Object.keys(workingDump.materials ?? {}).length,
    };
  }, [targets, workingDump]);

  useEffect(() => {
    if (!target || !workingDump) return;
    const next = Object.fromEntries(
      controls.map((control) => [control.identifier, control.value]),
    ) as Record<string, number | boolean>;
    setOverrides(next);
    setGeometryInput(String(geometryInputs[0]?.identifier ?? ""));
    setGeometryOutput(String(geometryOutputs[0]?.identifier ?? ""));
    if (target.kind === "object") setSeedValue("cube");
  }, [sourceKey, target?.id]);

  useEffect(() => {
    if (!workingDump || !target) return;
    runtime.queue({
      dump: workingDump,
      target,
      overrides,
      seed: target.kind === "group" && geometryInputs.length ? seedFromValue(seedValue) : undefined,
      geometryInput: geometryInput || undefined,
      output: geometryOutput || undefined,
    });
  }, [geometryInput, geometryInputs.length, geometryOutput, overrides, seedValue, target, workingDump, runtime.queue]);

  useEffect(() => {
    if (!graphMaximized) return;
    const restore = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setGraphMaximized(false);
    };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [graphMaximized]);

  useEffect(() => {
    if (!graphOpen) return;
    const frame = window.requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent(editorConfig.events.resize)));
    return () => window.cancelAnimationFrame(frame);
  }, [graphMaximized, graphOpen]);

  const installDump = useCallback((dump: ImportedDump, filename: string, bytes: number): void => {
    if (!dump.node_groups || typeof dump.node_groups !== "object") {
      throw new Error("The selected JSON is not a BlendBridge graph dump");
    }
    const installed = structuredClone(dump);
    const nextTargets = discoverBlendStudioTargets(installed);
    setSourceDump(installed);
    setWorkingDump(installed);
    setSourceName(dump.import_meta?.filename || filename);
    setSourceBytes(dump.import_meta?.bytes ?? bytes);
    const fingerprint = dump.extraction_metadata?.source?.fingerprint_sha256
      ?? `${filename}:${bytes}`;
    setSourceKey(`${fingerprint}:${++importSerial.current}`);
    setTargetId(nextTargets[0]?.id ?? "");
    setImportMessage(nextTargets.length
      ? `${nextTargets.length} runnable object or reusable group targets discovered`
      : "Graph extracted, but no Geometry Nodes output target was found");
    setGraphOpen(true);
  }, []);

  const importFile = useCallback(async (file: File): Promise<void> => {
    setBusy(true);
    setImportMessage(file.name.toLowerCase().endsWith(".json")
      ? "Reading portable graph…"
      : "Blender is extracting nodes, objects, dependencies, and materials…");
    try {
      let dump: ImportedDump;
      if (file.name.toLowerCase().endsWith(".json")) {
        dump = JSON.parse(await file.text()) as ImportedDump;
      } else {
        if (isStaticDeploy) {
          throw new Error("Direct .blend extraction needs the local app; extracted JSON still works here");
        }
        const response = await fetch("/api/blend-import", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Blend-Filename": file.name,
          },
          body: file,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Import failed (${response.status})`);
        dump = body as ImportedDump;
      }
      installDump(dump, file.name, file.size);
    } catch (error) {
      setImportMessage(`Import failed · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [installDump]);

  const loadSample = useCallback(async (): Promise<void> => {
    setBusy(true);
    setImportMessage("Loading included procedural bin graph…");
    try {
      const response = await fetch(publicUrl("dojo/dump_bin.json"));
      if (!response.ok) throw new Error(`Sample failed (${response.status})`);
      const dump = await response.json() as ImportedDump;
      installDump(dump, "dojo-bin-sample.json", Number(response.headers.get("content-length")) || 0);
    } catch (error) {
      setImportMessage(`Sample failed · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [installDump]);

  const graphSource = sourceDump && target ? {
    sourceKey: `${sourceKey}:${target.id}`,
    dump: sourceDump,
    objectName: target.kind === "object" ? target.objectName : undefined,
    rootGroupName: target.groupName,
  } : undefined;

  const leftDock = <>
    <header className="studio-dock-header"><span>Source</span><small>local Blender bridge</small></header>
    <section>
      <p className="blend-studio-copy">Import a `.blend` to extract its complete Geometry Nodes closure, then edit and evaluate it without changing the source file.</p>
      <button
        className={`blend-dropzone ${dragging ? "dragging" : ""}`}
        type="button"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) void importFile(file);
        }}
      >
        <b>{busy ? "Extracting…" : "Drop .blend or .json"}</b>
        <span>Local extraction · source remains untouched</span>
      </button>
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".blend,.json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
      <button className="blend-secondary-button" type="button" disabled={busy} onClick={() => void loadSample()}>Try included bin sample</button>
      <div className="blend-source-status">
        <span className={health?.available ? "ready" : ""} />
        <div><b>{sourceName || (health?.available ? "Blender ready" : "Portable JSON mode")}</b><small>{sourceName ? `${humanBytes(sourceBytes)} · Blender ${sourceDump?.blender_version ?? "unknown"}` : importMessage}</small></div>
      </div>
    </section>
    <section>
      <label className="blend-field">
        <span>Execution target</span>
        <select
          disabled={!targets.length}
          value={target?.id ?? ""}
          onChange={(event) => {
            runtime.cancel();
            setTargetId(event.target.value);
            setWorkingDump(sourceDump ? structuredClone(sourceDump) : null);
          }}
        >
          {!targets.length && <option>Import a graph first</option>}
          {targets.map((item) => <option key={item.id} value={item.id}>
            {item.kind === "object" ? "Object" : "Group"} · {item.label}
          </option>)}
        </select>
      </label>
      {target?.kind === "group" && geometryInputs.length > 0 && <label className="blend-field">
        <span>Geometry input</span>
        <select value={seedValue} onChange={(event) => setSeedValue(event.target.value)}>
          <option value="cube">Primitive · Cube</option>
          <option value="plane">Primitive · Plane</option>
          <option value="curve-circle">Primitive · Curve circle</option>
          <option value="curve-line">Primitive · Curve line</option>
          {seedObjects.map((name) => <option key={name} value={`object:${name}`}>Object · {name}</option>)}
        </select>
      </label>}
      {target?.kind === "group" && geometryInputs.length > 1 && <label className="blend-field">
        <span>Input socket</span>
        <select value={geometryInput} onChange={(event) => setGeometryInput(event.target.value)}>
          {geometryInputs.map((item) => <option key={item.identifier} value={item.identifier}>{item.name}</option>)}
        </select>
      </label>}
      {target?.kind === "group" && geometryOutputs.length > 1 && <label className="blend-field">
        <span>Preview output</span>
        <select value={geometryOutput} onChange={(event) => setGeometryOutput(event.target.value)}>
          {geometryOutputs.map((item) => <option key={item.identifier} value={item.identifier}>{item.name}</option>)}
        </select>
      </label>}
      <div className="blend-button-row">
        <button
          type="button"
          disabled={!workingDump || !target || runtime.snapshot.state === "evaluating"}
          onClick={() => {
            if (!workingDump || !target) return;
            void runtime.evaluate({
              dump: workingDump,
              target,
              overrides,
              seed: target.kind === "group" && geometryInputs.length ? seedFromValue(seedValue) : undefined,
              geometryInput: geometryInput || undefined,
              output: geometryOutput || undefined,
            }).catch(() => {});
          }}
        >Evaluate now</button>
        <button type="button" disabled={!workingDump} onClick={() => {
          if (!workingDump) return;
          const base = (sourceName || "blend-graph").replace(/\.blend$/i, "").replace(/[^a-z0-9._-]+/gi, "-");
          download(`${base}.nodes.json`, JSON.stringify(workingDump));
        }}>Export JSON</button>
      </div>
    </section>
    <section>
      <div className="section-title"><span>Exposed inputs</span><small>{controls.length} editable</small></div>
      <div className="blend-controls">
        {controls.length === 0 && <p>No numeric or boolean inputs are exposed by this target.</p>}
        {controls.map((control) => <label key={control.identifier}>
          <span>{control.name}</span>
          {control.socketType === "NodeSocketBool"
            ? <input
                type="checkbox"
                checked={Boolean(overrides[control.identifier])}
                onChange={(event) => setOverrides((current) => ({ ...current, [control.identifier]: event.target.checked }))}
              />
            : <>
                <input
                  type="range"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={Number(overrides[control.identifier] ?? control.value)}
                  onChange={(event) => setOverrides((current) => ({ ...current, [control.identifier]: Number(event.target.value) }))}
                />
                <output>{Number(overrides[control.identifier] ?? control.value).toFixed(control.step === 1 ? 0 : 3)}</output>
              </>}
        </label>)}
      </div>
    </section>
  </>;

  const rightDock = <>
    <header className="studio-dock-header"><span>Compatibility</span><small>static + executed</small></header>
    <section>
      <div className={`blend-runtime-status ${runtime.snapshot.state}`}>
        <span />
        <div><b>{runtime.snapshot.state}</b><small>{runtime.snapshot.message}</small></div>
      </div>
      {target && <p className="blend-target-detail">{target.groupName}<br />{target.kind === "object" ? target.objectName : "Direct reusable group"}</p>}
    </section>
    <section className="blend-metrics">
      <article><strong>{inventory.objects}</strong><span>modifier targets</span></article>
      <article><strong>{inventory.groups}</strong><span>node groups</span></article>
      <article><strong>{inventory.nodes.toLocaleString()}</strong><span>all nodes</span></article>
      <article><strong>{inventory.materials}</strong><span>materials</span></article>
    </section>
    {compatibility && <section>
      <div className="blend-compat-score"><strong>{compatibility.score}%</strong><div><b>reachable records recognized</b><span>{compatibility.recognizedNodes}/{compatibility.totalNodes} nodes · {compatibility.report.reachableGroups.length} groups</span></div></div>
      <div className="blend-gaps">
        {compatibility.gaps.length
          ? compatibility.gaps.map((gap) => <span key={gap}>{gap}</span>)
          : <p>No statically unsupported nodes in this target closure.</p>}
      </div>
    </section>}
    {runtime.snapshot.stats && <section className="blend-result">
      <span className="panel-label">Last valid result</span>
      {runtime.snapshot.stats.verts || runtime.snapshot.stats.faces
        ? <>
            <strong>{runtime.snapshot.stats.verts.toLocaleString()} vertices</strong>
            <b>{runtime.snapshot.stats.faces.toLocaleString()} faces · {runtime.snapshot.stats.tris.toLocaleString()} triangles</b>
          </>
        : runtime.snapshot.lineStats
          ? <>
              <strong>{runtime.snapshot.lineStats.evaluatedPoints.toLocaleString()} curve points</strong>
              <b>{runtime.snapshot.lineStats.segments.toLocaleString()} segments · {runtime.snapshot.lineStats.splines.toLocaleString()} splines</b>
            </>
          : <strong>Empty geometry output</strong>}
      <small>{runtime.snapshot.runtimeSeconds?.toFixed(2)}s in worker</small>
      {(runtime.snapshot.missingTypes ?? []).map((entry) =>
        <em key={entry.type}>{entry.type} ×{entry.count}</em>)}
    </section>}
    <section className="blend-note">
      <span className="panel-label">Truth contract</span>
      <p>Static coverage means a handler exists. Only a Blender parity fixture proves that its behavior matches the authored tool.</p>
      <p>Failed edits retain the previous valid viewport result.</p>
    </section>
  </>;

  return <StudioShell
    eyebrow="Local Blender portability lab"
    title={sourceName || "BlendBridge Studio"}
    subtitle={target ? <>{target.kind === "object" ? "Modifier object" : "Reusable group"} · {target.label}</> : "Import · inspect · edit · evaluate"}
    docksOpen={docksOpen}
    onToggleDocks={() => setDocksOpen((open) => !open)}
    leftDock={leftDock}
    rightDock={rightDock}
    footer={<>Three.js viewport · Blender remains semantic truth</>}
  >
    <canvas ref={runtime.canvasRef} id="blend-studio-canvas" />
    {!workingDump && <div className="blend-empty-state">
      <div className="blend-empty-orbit" />
      <h1>Bring a Geometry Nodes tool into the studio.</h1>
      <p>{importMessage}</p>
    </div>}
    {!graphOpen && workingDump && <button className="graph-toggle" type="button" onClick={() => setGraphOpen(true)}>Show Geometry Nodes workspace</button>}
    {graphOpen && graphSource && target && <FloatingStudioPanel
      className="crayon-graph blend-graph"
      rect={graphRect}
      onRectChange={(rect) => {
        setGraphRect(rect);
        try {
          localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ graphRect: rect }));
        } catch {
          // UI persistence is optional.
        }
      }}
      maximized={graphMaximized}
      title={`Geometry Nodes · ${target.label}`}
      actions={<>
        <span>{target.groupName}</span>
        <button type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Maximize"}</button>
        <button type="button" onClick={() => { setGraphMaximized(false); setGraphOpen(false); }}>Hide</button>
      </>}
    >
      <GeometryNodesEditor
        config={editorConfig}
        source={graphSource}
        onDumpChange={setWorkingDump}
      />
    </FloatingStudioPanel>}
  </StudioShell>;
}
