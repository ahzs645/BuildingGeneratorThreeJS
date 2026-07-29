import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { isStaticDeploy, publicUrl } from "../../base-url";
import { animationFrameRange, type Dump } from "../../gnvm";
import {
  autoEvaluationPolicyForBlendStudioTarget,
  BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS,
  blendStudioEvaluationHistoryKey,
  blendStudioEvaluationRunsForKey,
  compatibilityForBlendStudioTarget,
  connectedGeometryInputsForBlendStudioTarget,
  controlsForBlendStudioTarget,
  datablockControlsForBlendStudioTarget,
  discoverBlendStudioTargets,
  progressivePreviewContractForBlendStudioTarget,
  recordBlendStudioEvaluationRun,
  seedableObjectNames,
  touchBlendStudioEvaluationHistory,
  type BlendStudioEvaluationHistoryStore,
  type BlendStudioEvaluationRunRecord,
  type BlendStudioSeed,
} from "../../blend-studio/model";
import {
  dependencyExtractionPackage,
  type DependencyExtractionPackage,
} from "../../blend-studio/dependency-extraction";
import { presetContractForBlendStudioTarget } from "../../blend-studio/preset-contracts";
import { sceneUnits } from "../../blend-studio/units";
import {
  applyViewerPreview,
  viewerPreviewsForBlendStudioTarget,
} from "../../blend-studio/viewer-previews";
import {
  gizmoContractsForBlendStudioTarget,
  setGizmoValue,
} from "../../blend-studio/gizmos";
import {
  authoredValueFromMeasurementDistance,
  interpretMeasurementDisplay,
  linearMeasurementContractForBlendStudioTarget,
  measurementDistanceForDisplay,
  measurementDistanceFromAuthoredValue,
  measurementDistanceFromDisplay,
  measurementDistanceRange,
  type BlendStudioMeasurementUnit,
} from "../../blend-studio/measurement";
import {
  BLEND_STUDIO_EVALUATION_TIMEOUT_MS,
  type BlendStudioEvaluation,
  type BlendStudioMeasurementMode,
  type BlendStudioMeasurementSubjectSnapshot,
  type BlendStudioPointMeasurementSnapshot,
  type BlendStudioRuntimeSnapshot,
} from "../../blend-studio/runtime";
import type { PortableGap } from "../../blend/index";
import GeometryNodesEditor from "../geometry-nodes/GeometryNodesEditor";
import {
  AssetLibraryOverlay,
  fetchAssetCatalog,
  libraryAssetStats,
  type LibraryAsset,
} from "../blend-studio/AssetLibrary";
import { useBlendStudioRuntime } from "../blend-studio/useBlendStudioRuntime";
import { usePageRuntime } from "../page-runtime";
import { FloatingStudioPanel, StudioShell, useMobileStudio, type StudioPanelRect } from "../studio/StudioShell";
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
const EVALUATION_HISTORY_STORAGE_KEY = "procedural-studio.blendbridge.evaluation-history";

function loadEvaluationHistoryStore(): unknown {
  try {
    return JSON.parse(localStorage.getItem(EVALUATION_HISTORY_STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function saveEvaluationHistoryStore(store: BlendStudioEvaluationHistoryStore): void {
  try {
    localStorage.setItem(EVALUATION_HISTORY_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Evaluation history persistence is optional.
  }
}

/** Read a target's measured runs and refresh its LRU last-use stamp. */
function storedEvaluationRuns(key: string): BlendStudioEvaluationRunRecord[] {
  const store = loadEvaluationHistoryStore();
  const runs = blendStudioEvaluationRunsForKey(store, key);
  if (runs.length) {
    const touched = touchBlendStudioEvaluationHistory(store, key, Date.now());
    if (touched) saveEvaluationHistoryStore(touched);
  }
  return runs;
}

function persistEvaluationRun(
  key: string,
  run: BlendStudioEvaluationRunRecord,
): BlendStudioEvaluationRunRecord[] {
  const next = recordBlendStudioEvaluationRun(loadEvaluationHistoryStore(), key, run);
  saveEvaluationHistoryStore(next);
  return blendStudioEvaluationRunsForKey(next, key);
}

// Sized so the 3D preview stays visible above the panel — the workspace is a
// tool alongside the viewport, not a takeover.
function defaultGraphRect(): StudioPanelRect {
  const width = Math.min(1120, Math.max(640, window.innerWidth - 650));
  const height = Math.min(480, Math.max(360, window.innerHeight - 430));
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
  usePageRuntime("Procedural Studio · Blender Geometry Nodes on the web");
  const { search } = useLocation();
  const fileInput = useRef<HTMLInputElement>(null);
  const workpieceInput = useRef<HTMLInputElement>(null);
  const importSerial = useRef(0);
  const isMobile = useMobileStudio();
  const [docksOpen, setDocksOpen] = useState(true);
  // Mobile starts with the graph overlay closed; the FAB is its entry point.
  const [graphOpen, setGraphOpen] = useState(!isMobile);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const [graphRect, setGraphRect] = useState(initialGraphRect);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryAsset, setLibraryAsset] = useState<LibraryAsset | null>(null);
  const [importMessage, setImportMessage] = useState("Drop a Blender file or load the included sample");
  const [decoderGaps, setDecoderGaps] = useState<PortableGap[] | null>(null);
  const [sourceDump, setSourceDump] = useState<ImportedDump | null>(null);
  const [workingDump, setWorkingDump] = useState<Dump | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceBytes, setSourceBytes] = useState(0);
  const [sourceKey, setSourceKey] = useState("");
  const [sourceFingerprint, setSourceFingerprint] = useState("");
  const [evaluationRuns, setEvaluationRuns] =
    useState<readonly BlendStudioEvaluationRunRecord[]>([]);
  const recordedSnapshot = useRef<BlendStudioRuntimeSnapshot | null>(null);
  const lastQueuedEvaluation = useRef<BlendStudioEvaluation | null>(null);
  const [targetId, setTargetId] = useState("");
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [animationFrame, setAnimationFrame] = useState(0);
  const [volumeSampleBudget, setVolumeSampleBudget] = useState(1_000_000);
  const [seedValue, setSeedValue] = useState("authored");
  const [geometryInput, setGeometryInput] = useState("");
  const [geometryOutput, setGeometryOutput] = useState("");
  const [showHiddenControls, setShowHiddenControls] = useState(false);
  const [dependencySummary, setDependencySummary] =
    useState<DependencyExtractionPackage["summary"] | null>(null);
  const [measurementUnit, setMeasurementUnit] =
    useState<BlendStudioMeasurementUnit>("mm");
  const [measurementMode, setMeasurementMode] =
    useState<BlendStudioMeasurementMode>("jaw");
  const [measurementZeroMm, setMeasurementZeroMm] = useState(0);
  const [pointMeasurement, setPointMeasurement] =
    useState<BlendStudioPointMeasurementSnapshot>({ points: [] });
  const [measurementSubject, setMeasurementSubject] =
    useState<BlendStudioMeasurementSubjectSnapshot | null>(null);
  const [measurementSubjectFile, setMeasurementSubjectFile] = useState<File | null>(null);
  const [measurementSubjectMessage, setMeasurementSubjectMessage] =
    useState("Optional · load a GLB, OBJ, or STL workpiece");
  const [workpieceMillimetersPerUnit, setWorkpieceMillimetersPerUnit] = useState(1);
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
  const datablockControls = useMemo(
    () => workingDump && target
      ? datablockControlsForBlendStudioTarget(workingDump, target)
      : [],
    [target, workingDump],
  );
  const gizmoContracts = useMemo(
    () => workingDump && target
      ? gizmoContractsForBlendStudioTarget(workingDump, target)
      : [],
    [target, workingDump],
  );
  const measurementContract = useMemo(
    () => target
      ? (workingDump
          ? linearMeasurementContractForBlendStudioTarget(workingDump, target.groupName)
          : null)
        ?? (sourceDump
          ? linearMeasurementContractForBlendStudioTarget(sourceDump, target.groupName)
          : null)
      : null,
    [sourceDump, target, workingDump],
  );
  const ordinaryControls = useMemo(
    () => controls.filter((control) =>
      control.identifier !== measurementContract?.inputIdentifier
      && control.identifier !== measurementContract?.batteryInputIdentifier),
    [controls, measurementContract],
  );
  const compatibility = useMemo(
    () => workingDump && target ? compatibilityForBlendStudioTarget(workingDump, target) : null,
    [target, workingDump],
  );
  const hasVolumeBoundary = Boolean(compatibility?.report.approximatedNodeTypes.some((entry) =>
    [
      "GeometryNodeGridToMesh",
      "GeometryNodeMeshToSDFGrid",
      "GeometryNodePointsToSDFGrid",
      "GeometryNodeVolumeCube",
      "GeometryNodeVolumeToMesh",
    ].includes(entry.type)));
  const evaluationHistoryKey = sourceFingerprint && target
    ? blendStudioEvaluationHistoryKey(sourceFingerprint, target.id)
    : "";
  const autoEvaluation = useMemo(
    () => workingDump && target
      ? autoEvaluationPolicyForBlendStudioTarget(workingDump, target, evaluationRuns)
      : null,
    [evaluationRuns, target, workingDump],
  );
  const progressiveContract = useMemo(
    () => workingDump && target
      ? progressivePreviewContractForBlendStudioTarget(workingDump, target)
      : null,
    [target, workingDump],
  );
  // Two-phase previews only make sense when the target is measured-slow: the
  // last recorded run exceeded the live-edit disable budget (timeouts and
  // errors record the safety ceiling, so they count as slow too).
  const lastMeasuredRun = evaluationRuns[evaluationRuns.length - 1];
  const progressivePreviewApplies = Boolean(
    progressiveContract
    && lastMeasuredRun
    && (lastMeasuredRun.outcome !== "ready"
      || lastMeasuredRun.seconds > BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS),
  );
  const presetContract = useMemo(
    () => workingDump && target ? presetContractForBlendStudioTarget(workingDump, target) : null,
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
  const connectedGeometryInputs = useMemo(
    () => workingDump && target
      ? connectedGeometryInputsForBlendStudioTarget(workingDump, target)
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
  const viewerPreviews = useMemo(
    () => workingDump && target
      ? viewerPreviewsForBlendStudioTarget(workingDump, target.groupName)
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
  const extractionWarnings = workingDump?.extraction_metadata?.warnings ?? [];
  const sourceUnits = useMemo(
    () => workingDump ? sceneUnits(workingDump) : null,
    [workingDump],
  );
  const animatedFrameRange = useMemo(
    () => workingDump ? animationFrameRange(workingDump) : null,
    [workingDump],
  );

  useEffect(() => {
    let current = true;
    setDependencySummary(null);
    if (sourceDump) {
      void dependencyExtractionPackage(sourceDump).then((result) => {
        if (current) setDependencySummary(result.summary);
      }).catch(() => {
        if (current) setDependencySummary(null);
      });
    }
    return () => {
      current = false;
    };
  }, [sourceDump]);

  useEffect(() => {
    if (!target || !workingDump) return;
    const next = Object.fromEntries(
      [
        ...controls.map((control) => [control.identifier, control.value] as const),
        ...datablockControls.map((control) => [control.identifier, control.value] as const),
        ...gizmoContracts.map((contract) =>
          [contract.rootInputIdentifier, contract.rootValue] as const),
      ],
    );
    setOverrides(next);
    setGeometryInput(String(connectedGeometryInputs[0]?.identifier ?? ""));
    setGeometryOutput(String(geometryOutputs[0]?.identifier ?? ""));
    setSeedValue(
      presetContract?.mode === "seed" && presetContract.recommendedSeed
        ? presetContract.recommendedSeed.kind
        : target.kind === "object" ? "authored" : "cube",
    );
  }, [
    connectedGeometryInputs,
    controls,
    datablockControls,
    gizmoContracts,
    geometryOutputs,
    presetContract,
    sourceKey,
    target,
    workingDump,
  ]);

  useEffect(() => {
    setAnimationFrame(Number(
      workingDump?.scene?.frame_current
      ?? animatedFrameRange?.[0]
      ?? 0,
    ));
  }, [animatedFrameRange, sourceKey, workingDump?.scene?.frame_current]);

  const interpretedDump = useMemo(
    () => workingDump && measurementContract?.display
      ? interpretMeasurementDisplay(workingDump, measurementContract, {
          zeroOffsetMm: measurementZeroMm,
          unit: measurementUnit,
        })
      : workingDump,
    [
      measurementContract,
      measurementUnit,
      measurementZeroMm,
      workingDump,
    ],
  );

  const evaluation = useMemo(() => {
    if (!interpretedDump || !target) return null;
    const selectedViewer = geometryOutput.startsWith("viewer:")
      ? viewerPreviews.find((preview) => `viewer:${preview.id}` === geometryOutput)
      : undefined;
    const viewerApplication = selectedViewer
      ? applyViewerPreview(interpretedDump, selectedViewer)
      : null;
    return {
      dump: viewerApplication?.dump ?? interpretedDump,
      target,
      overrides,
      seed: connectedGeometryInputs.length && seedValue !== "authored"
        ? seedFromValue(seedValue)
        : undefined,
      geometryInput: geometryInput || undefined,
      output: viewerApplication?.outputIdentifier
        ?? (geometryOutput.startsWith("viewer:") ? undefined : geometryOutput || undefined),
      frame: animationFrame,
      volumeSampleBudget: hasVolumeBoundary ? volumeSampleBudget : undefined,
    };
  }, [animationFrame, connectedGeometryInputs.length, geometryInput, geometryOutput, hasVolumeBoundary, interpretedDump, overrides, seedValue, target, viewerPreviews, volumeSampleBudget]);

  // Attach the two-phase low-res preview at dispatch time (not inside the
  // evaluation memo, whose identity gates the live-edit queue) so a request is
  // progressive exactly when the target is measured-slow and lowering the
  // resolution-class input would actually reduce work.
  const withProgressivePreview = useCallback(
    (request: BlendStudioEvaluation): BlendStudioEvaluation => {
      if (!progressivePreviewApplies || !progressiveContract) return request;
      const { control, previewValue } = progressiveContract;
      const current = Number(request.overrides[control.identifier] ?? control.value);
      if (!Number.isFinite(current) || current <= previewValue) return request;
      return {
        ...request,
        progressive: { identifier: control.identifier, name: control.name, previewValue },
      };
    },
    [progressiveContract, progressivePreviewApplies],
  );

  const authoredMeasurementValue = measurementContract
    ? Number(
        overrides[measurementContract.inputIdentifier]
        ?? controls.find((control) =>
          control.identifier === measurementContract.inputIdentifier)?.value
        ?? 0,
      )
    : 0;
  const physicalMeasurementMm = measurementContract
    ? measurementDistanceFromAuthoredValue(
        measurementContract,
        authoredMeasurementValue,
      )
    : 0;
  const displayedMeasurementMm = physicalMeasurementMm - measurementZeroMm;
  const displayedMeasurement = measurementDistanceForDisplay(
    displayedMeasurementMm,
    measurementUnit,
  );
  const measurementRange = measurementContract
    ? measurementDistanceRange(measurementContract)
    : [0, 0] as [number, number];
  const modeledCapacityMm = Math.min(measurementRange[1], 200);
  const batteryControl = controls.find((control) =>
    control.identifier === measurementContract?.batteryInputIdentifier);
  const batteryValue = batteryControl
    ? Number(overrides[batteryControl.identifier] ?? batteryControl.value)
    : 0;

  const setPhysicalMeasurementMm = useCallback((distanceMm: number): void => {
    if (!measurementContract) return;
    const [, graphMaximum] = measurementDistanceRange(measurementContract);
    const capacityMm = Math.min(graphMaximum, 200);
    const boundedDistanceMm = Math.min(
      Math.max(Number.isFinite(distanceMm) ? distanceMm : 0, 0),
      capacityMm,
    );
    setOverrides((current) => ({
      ...current,
      [measurementContract.inputIdentifier]:
        authoredValueFromMeasurementDistance(measurementContract, boundedDistanceMm),
    }));
  }, [measurementContract]);

  useEffect(() => {
    if (!measurementContract) {
      runtime.configureMeasurement(null);
      return;
    }
    runtime.configureMeasurement({
      contract: measurementContract,
      authoredValue: authoredMeasurementValue,
      mode: measurementMode,
      onAuthoredValue(value) {
        setPhysicalMeasurementMm(
          measurementDistanceFromAuthoredValue(measurementContract, value),
        );
      },
      onPointMeasurement: setPointMeasurement,
    });
  }, [
    authoredMeasurementValue,
    measurementContract,
    measurementMode,
    runtime.configureMeasurement,
    setPhysicalMeasurementMm,
  ]);

  useEffect(() => {
    const directContracts = gizmoContracts.filter((contract) =>
      contract.rootInputIdentifier !== measurementContract?.inputIdentifier);
    if (!directContracts.length) {
      runtime.configureGizmos(null);
      return;
    }
    runtime.configureGizmos({
      contracts: directContracts,
      values: overrides,
      onValue(contract, value) {
        setOverrides((current) => setGizmoValue(current, contract, value));
      },
    });
  }, [
    gizmoContracts,
    measurementContract?.inputIdentifier,
    overrides,
    runtime.configureGizmos,
  ]);

  useEffect(() => {
    setMeasurementZeroMm(0);
    setPointMeasurement({ points: [] });
    setMeasurementSubject(null);
    setMeasurementSubjectFile(null);
    setMeasurementSubjectMessage("Optional · load a GLB, OBJ, or STL workpiece");
    runtime.clearMeasurementSubject();
  }, [runtime.clearMeasurementSubject, sourceKey, target?.id]);

  // A re-import of a known tool (same fingerprint) starts with its measured
  // evaluation history instead of falling back to the node-count default.
  useEffect(() => {
    setEvaluationRuns(evaluationHistoryKey ? storedEvaluationRuns(evaluationHistoryKey) : []);
  }, [evaluationHistoryKey]);

  // Record every completed evaluation of the current target so the live-edit
  // gate stays empirical. Timeouts and errors count as slow: they record the
  // 180 s safety ceiling rather than nothing.
  useEffect(() => {
    const snapshot = runtime.snapshot;
    if (recordedSnapshot.current === snapshot) return;
    recordedSnapshot.current = snapshot;
    if (!evaluationHistoryKey) return;
    // Low-res progressive previews measure the preview pass, not the target's
    // real cost; only the full-quality phase may drive the live-edit gate.
    if (snapshot.preview) return;
    if (snapshot.state === "ready" && typeof snapshot.runtimeSeconds === "number") {
      setEvaluationRuns(persistEvaluationRun(evaluationHistoryKey, {
        seconds: snapshot.runtimeSeconds,
        outcome: "ready",
        at: Date.now(),
      }));
    } else if (snapshot.state === "error") {
      setEvaluationRuns(persistEvaluationRun(evaluationHistoryKey, {
        seconds: BLEND_STUDIO_EVALUATION_TIMEOUT_MS / 1_000,
        outcome: snapshot.message.includes("safety limit") ? "timeout" : "error",
        at: Date.now(),
      }));
    }
  }, [evaluationHistoryKey, runtime.snapshot]);

  useEffect(() => {
    if (evaluation && autoEvaluation?.enabled) {
      // When live evaluation unlocks because a measured run completed, the
      // current request has already been evaluated; only queue actual edits.
      if (lastQueuedEvaluation.current === evaluation) return;
      lastQueuedEvaluation.current = evaluation;
      runtime.queue(withProgressivePreview(evaluation));
    } else runtime.cancel();
  }, [autoEvaluation?.enabled, evaluation, runtime.cancel, runtime.queue, withProgressivePreview]);

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
    // Library loads re-assert their asset right after this call; direct
    // imports leave the studio in plain .blend/.json mode.
    setLibraryAsset(null);
    setSourceDump(installed);
    setWorkingDump(installed);
    setSourceName(dump.import_meta?.filename || filename);
    setSourceBytes(dump.import_meta?.bytes ?? bytes);
    const fingerprint = dump.extraction_metadata?.source?.fingerprint_sha256
      ?? `${filename}:${bytes}`;
    setSourceFingerprint(fingerprint);
    setSourceKey(`${fingerprint}:${++importSerial.current}`);
    setTargetId(nextTargets[0]?.id ?? "");
    setImportMessage(nextTargets.length
      ? `${nextTargets.length} runnable object or reusable group targets discovered`
      : "Graph extracted, but no Geometry Nodes output target was found");
    // Desktop-only: auto-opening the full-screen overlay would hide the
    // freshly imported preview on mobile, where the FAB opens it on demand.
    if (!isMobile) setGraphOpen(true);
  }, [isMobile]);

  const importFile = useCallback(async (file: File): Promise<void> => {
    const isJson = file.name.toLowerCase().endsWith(".json");
    // Blender extracts strictly more than the browser can (base meshes, node
    // properties, packed resources), so prefer it whenever it is reachable and
    // fall back to the in-browser DNA decoder everywhere else.
    const useBlender = !isJson && !isStaticDeploy && health?.available === true;
    setBusy(true);
    setDecoderGaps(null);
    setImportMessage(isJson
      ? "Reading portable graph…"
      : useBlender
        ? "Blender is extracting nodes, objects, dependencies, and materials…"
        : "Decoding the Blender file in your browser…");
    try {
      let dump: ImportedDump;
      if (isJson) {
        dump = JSON.parse(await file.text()) as ImportedDump;
      } else if (useBlender) {
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
      } else {
        const { decodeBlend } = await import("../../blend/index");
        const decoded = await decodeBlend(new Uint8Array(await file.arrayBuffer()), { filename: file.name });
        dump = decoded.dump as ImportedDump;
        setDecoderGaps(decoded.gaps);
      }
      installDump(dump, file.name, file.size);
    } catch (error) {
      setImportMessage(`Import failed · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [health?.available, installDump]);

  const loadSample = useCallback(async (): Promise<void> => {
    setBusy(true);
    setDecoderGaps(null);
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

  const loadLibraryAsset = useCallback(async (asset: LibraryAsset): Promise<void> => {
    setLibraryOpen(false);
    setBusy(true);
    setDecoderGaps(null);
    setImportMessage(`Loading ${asset.title} from the asset library…`);
    try {
      const [dumpResponse, shaderMetadata] = await Promise.all([
        fetch(publicUrl(asset.dump), { cache: "no-store" }),
        asset.shaderMetadata
          ? fetch(publicUrl(asset.shaderMetadata), { cache: "no-store" })
              .then((response) => response.ok ? response.json() : null)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!dumpResponse.ok) throw new Error(`Asset dump failed (${dumpResponse.status})`);
      const dumpText = await dumpResponse.text();
      const dump = Object.assign(
        JSON.parse(dumpText) as ImportedDump,
        shaderMetadata ?? {},
      );
      installDump(dump, asset.title, dumpText.length);
      // Library loads are about seeing and modulating the asset; the node
      // workspace stays one click away instead of covering the preview.
      setGraphOpen(false);
      // Prefer the asset's authored modifier object over the first discovered
      // target so the studio opens on the same geometry the library shows.
      const authoredTarget = discoverBlendStudioTargets(dump).find((candidate) =>
        candidate.kind === "object" && candidate.objectName === asset.object);
      if (authoredTarget) setTargetId(authoredTarget.id);
      setLibraryAsset(asset);
    } catch (error) {
      setImportMessage(`Asset failed · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [installDump]);

  // Deep link from the parity lab (and shared URLs): /?asset=<catalog-id>
  // loads that library asset straight into the studio.
  const requestedLibraryAsset = useMemo(
    () => new URLSearchParams(search).get("asset"),
    [search],
  );
  const handledLibraryAssetParam = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedLibraryAsset || handledLibraryAssetParam.current === requestedLibraryAsset) return;
    handledLibraryAssetParam.current = requestedLibraryAsset;
    let cancelled = false;
    fetchAssetCatalog().then((catalog) => {
      const asset = catalog.find((item) => item.id === requestedLibraryAsset);
      if (!cancelled && asset) void loadLibraryAsset(asset);
      else if (!cancelled && !asset) setImportMessage(`Unknown library asset · ${requestedLibraryAsset}`);
    }).catch(() => {
      if (!cancelled) setImportMessage("Asset catalog failed to load");
    });
    return () => { cancelled = true; };
  }, [loadLibraryAsset, requestedLibraryAsset]);

  const loadMeasurementSubject = useCallback(async (
    file: File,
    scaleOverride?: number,
  ): Promise<void> => {
    // This studio primarily handles Blender/3D-print assets whose authored
    // coordinates are millimetres, including the audit GLBs in this project.
    // Standards-compliant metre-scale GLBs remain one explicit selector away.
    const defaultScale = scaleOverride ?? 1;
    setMeasurementSubjectFile(file);
    setWorkpieceMillimetersPerUnit(defaultScale);
    setMeasurementSubjectMessage(`Loading ${file.name}…`);
    try {
      const subject = await runtime.loadMeasurementSubject(file, defaultScale);
      setMeasurementSubject(subject);
      setMeasurementSubjectMessage(
        `${subject.triangles.toLocaleString()} triangles · ${subject.dimensionsMm
          .map((value) => `${value.toFixed(2)} mm`)
          .join(" × ")}`,
      );
      setMeasurementMode("points");
    } catch (error) {
      setMeasurementSubject(null);
      setMeasurementSubjectMessage(
        `Workpiece failed · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [runtime.loadMeasurementSubject]);

  const graphSource = sourceDump && target ? {
    sourceKey: `${sourceKey}:${target.id}`,
    dump: sourceDump,
    objectName: target.kind === "object" ? target.objectName : undefined,
    rootGroupName: target.groupName,
  } : undefined;

  const hiddenControlCount = [
    ...ordinaryControls.filter((control) =>
      control.hiddenInModifier || control.hideValue),
    ...datablockControls.filter((control) => control.hiddenInModifier),
  ].length;
  const visibleOrdinaryControls = ordinaryControls.filter((control) =>
    showHiddenControls || (!control.hiddenInModifier && !control.hideValue));
  const visibleDatablockControls = datablockControls.filter((control) =>
    showHiddenControls || !control.hiddenInModifier);
  const controlPanelKeys = [...new Set([
    ...visibleOrdinaryControls.map((control) => control.panelPath.join(" › ")),
    ...visibleDatablockControls.map((control) => control.panelPath.join(" › ")),
  ])];

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
      <button className="blend-secondary-button blend-library-button" type="button" disabled={busy} onClick={() => setLibraryOpen(true)}>Browse the live asset library</button>
      {/* One source card at a time: the library card supersedes the generic
          import status row for catalog assets. */}
      {!libraryAsset && <div className="blend-source-status">
        <span className={health?.available ? "ready" : ""} />
        <div><b>{sourceName || (health?.available ? "Blender ready" : "Browser decoder ready")}</b><small>{sourceName ? `${humanBytes(sourceBytes)} · Blender ${sourceDump?.blender_version ?? "unknown"}${decoderGaps ? " · decoded in browser" : ""}` : importMessage}</small></div>
      </div>}
      {libraryAsset && <div className="blend-library-asset">
        <img src={publicUrl(libraryAsset.authoredReference ?? libraryAsset.reference)} alt={`${libraryAsset.title} Blender reference render`} />
        <div>
          <b>{libraryAsset.title}</b>
          <small>{libraryAssetStats(libraryAsset)} · Blender {sourceDump?.blender_version ?? "unknown"}</small>
          <Link to={`/chrome-assets?asset=${libraryAsset.id}`}>Side-by-side Blender compare →</Link>
        </div>
      </div>}
      {decoderGaps && decoderGaps.length > 0 && <details className="blend-decoder-gaps">
        <summary>{decoderGaps.length} capabilities Blender supplies that this file cannot</summary>
        <ul>
          {decoderGaps.map((gap) => <li key={gap.code}>
            <b>{gap.code.toLowerCase().replace(/_/g, " ")}</b>
            <span>{gap.detail}</span>
            {gap.subjects?.length ? <em>{gap.subjects.slice(0, 6).join(", ")}{gap.subjects.length > 6 ? " …" : ""}</em> : null}
          </li>)}
        </ul>
      </details>}
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
      {target && connectedGeometryInputs.length > 0 && <label className="blend-field">
        <span>Apply graph to</span>
        <select value={seedValue} onChange={(event) => setSeedValue(event.target.value)}>
          {target.kind === "object" && <option value="authored">Authored object · {target.objectName}</option>}
          <option value="cube">Primitive · Cube</option>
          <option value="plane">Primitive · Plane</option>
          <option value="curve-circle">Primitive · Curve circle</option>
          <option value="curve-line">Primitive · Curve line</option>
          {seedObjects.map((name) => <option key={name} value={`object:${name}`}>Object · {name}</option>)}
        </select>
      </label>}
      {target && connectedGeometryInputs.length > 1 && <label className="blend-field">
        <span>Input socket</span>
        <select value={geometryInput} onChange={(event) => setGeometryInput(event.target.value)}>
          {connectedGeometryInputs.map((item) => <option key={item.identifier} value={item.identifier}>{item.name}</option>)}
        </select>
      </label>}
      {target && geometryInputs.length > 0 && connectedGeometryInputs.length === 0
        && <p className="blend-studio-copy">Pure generator · its exposed Geometry socket is disconnected, so output is driven by node parameters.</p>}
      {target && (geometryOutputs.length > 1 || viewerPreviews.length > 0) && <label className="blend-field">
        <span>Preview output</span>
        <select value={geometryOutput} onChange={(event) => setGeometryOutput(event.target.value)}>
          {geometryOutputs.map((item) => <option key={item.identifier} value={item.identifier}>{item.name}</option>)}
          {viewerPreviews.map((preview) =>
            <option key={preview.id} value={`viewer:${preview.id}`}>Viewer · {preview.label}</option>)}
        </select>
      </label>}
      <div className="blend-button-row">
        <button
          type="button"
          disabled={!workingDump || !target || runtime.snapshot.state === "evaluating"}
          onClick={() => {
            if (!evaluation) return;
            lastQueuedEvaluation.current = evaluation;
            void runtime.evaluate(withProgressivePreview(evaluation)).catch(() => {});
          }}
        >Apply to preview</button>
        <button type="button" disabled={!interpretedDump} onClick={() => {
          if (!interpretedDump) return;
          const base = (sourceName || "blend-graph").replace(/\.blend$/i, "").replace(/[^a-z0-9._-]+/gi, "-");
          download(
            `${base}${measurementContract?.display ? ".interpreted" : ""}.nodes.json`,
            JSON.stringify(interpretedDump),
          );
        }}>Export JSON</button>
        <button className="blend-dependency-export" type="button" disabled={!workingDump} onClick={() => {
          if (!workingDump) return;
          const base = (sourceName || "blend-graph").replace(/\.blend$/i, "").replace(/[^a-z0-9._-]+/gi, "-");
          void dependencyExtractionPackage(workingDump).then((extractionPackage) => {
            download(`${base}.dependencies.json`, JSON.stringify(extractionPackage, null, 2));
          });
        }}>Export dependencies</button>
      </div>
    </section>
    {animatedFrameRange && <section>
      <div className="section-title">
        <span>Animation</span>
        <small>{`${animatedFrameRange[0]}–${animatedFrameRange[1]}`}</small>
      </div>
      <label className="blend-positive-measure">
        <span>Frame</span>
        <input
          type="number"
          min={animatedFrameRange[0]}
          max={animatedFrameRange[1]}
          step={1}
          value={animationFrame}
          onChange={(event) => setAnimationFrame(Number(event.target.value))}
        />
      </label>
      <input
        className="blend-measurement-slider"
        type="range"
        min={animatedFrameRange[0]}
        max={animatedFrameRange[1]}
        step={1}
        value={animationFrame}
        onChange={(event) => setAnimationFrame(Number(event.target.value))}
      />
      <p className="blend-studio-copy">
        Extracted Blender node-tree F-curves are evaluated at this frame before Geometry Nodes run.
      </p>
    </section>}
    {hasVolumeBoundary && <section>
      <div className="section-title">
        <span>Volume fidelity</span>
        <small>manual preview</small>
      </div>
      <label className="blend-field">
        <span>Dense sample ceiling</span>
        <select
          value={volumeSampleBudget}
          onChange={(event) => setVolumeSampleBudget(Number(event.target.value))}
        >
          <option value={1_000_000}>Interactive · 1 million</option>
          <option value={4_000_000}>Detailed · 4 million</option>
          <option value={12_000_000}>Parity probe · 12 million</option>
          <option value={16_000_000}>Maximum · 16 million</option>
        </select>
      </label>
      <p className="blend-studio-copy">
        Higher settings preserve the authored voxel spacing for larger grids,
        but intentionally remain manual because memory and evaluation time rise sharply.
      </p>
    </section>}
    {measurementContract && <section className="blend-measurement-tool">
      <div className="section-title">
        <span>Caliper measurement</span>
        <small>{measurementContract.display
          ? "LCD graph interpreted"
          : "Linear Gizmo detected"}</small>
      </div>
      <div className="blend-measurement-readout">
        <strong>{displayedMeasurement.toFixed(3)}</strong>
        <span>{measurementUnit}</span>
      </div>
      <div className="blend-segmented" aria-label="Measurement unit">
        {(["mm", "in"] as const).map((unit) => <button
          className={measurementUnit === unit ? "active" : ""}
          key={unit}
          type="button"
          onClick={() => setMeasurementUnit(unit)}
        >{unit}</button>)}
      </div>
      <label className="blend-positive-measure">
        <span>Positive opening</span>
        <input
          type="number"
          min={0}
          max={measurementDistanceForDisplay(modeledCapacityMm, measurementUnit)}
          step={.001}
          value={Number.isFinite(displayedMeasurement)
            ? Number(displayedMeasurement.toFixed(3))
            : 0}
          onChange={(event) => setPhysicalMeasurementMm(
            measurementDistanceFromDisplay(Number(event.target.value), measurementUnit)
            + measurementZeroMm,
          )}
        />
        <span>{measurementUnit}</span>
      </label>
      <input
        className="blend-measurement-slider"
        type="range"
        min={0}
        max={modeledCapacityMm}
        step={.05}
        value={Math.min(modeledCapacityMm, physicalMeasurementMm)}
        onChange={(event) => setPhysicalMeasurementMm(Number(event.target.value))}
      />
      <div className="blend-measurement-actions">
        <button type="button" onClick={() => {
          setMeasurementZeroMm(0);
          setPhysicalMeasurementMm(0);
        }}>Close &amp; zero</button>
        <button type="button" onClick={() =>
          setMeasurementZeroMm(physicalMeasurementMm)
        }>Zero here</button>
        <button
          type="button"
          disabled={measurementZeroMm === 0}
          onClick={() => setMeasurementZeroMm(0)}
        >Clear zero</button>
      </div>
      <div className="blend-segmented blend-measurement-modes" aria-label="Measurement mode">
        <button
          className={measurementMode === "jaw" ? "active" : ""}
          type="button"
          onClick={() => setMeasurementMode("jaw")}
        >Drag jaw</button>
        <button
          className={measurementMode === "points" ? "active" : ""}
          type="button"
          onClick={() => setMeasurementMode("points")}
        >Pick 2 points</button>
      </div>
      <p className="blend-studio-copy">
        {measurementMode === "jaw"
          ? "Drag the mint handle in the viewport. The positive value is mapped back to Blender’s authored negative socket."
          : pointMeasurement.missed
            ? "No workpiece surface at that point · pick directly on the shaded reference mesh."
            : pointMeasurement.points.length === 0
            ? "Pick two surfaces in the viewport to drive the jaw opening from their distance."
            : pointMeasurement.points.length === 1
              ? "First point set · pick the second point."
              : `Measured ${pointMeasurement.distanceMm?.toFixed(3)} mm between the selected points.`}
      </p>
      <div className="blend-workpiece">
        <input
          ref={workpieceInput}
          hidden
          type="file"
          accept=".glb,.obj,.stl,model/gltf-binary,model/obj"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void loadMeasurementSubject(file);
            event.target.value = "";
          }}
        />
        <button type="button" onClick={() => workpieceInput.current?.click()}>
          {measurementSubject ? "Replace workpiece" : "Load workpiece"}
        </button>
        <label>
          <span>File units</span>
          <select
            value={workpieceMillimetersPerUnit}
            onChange={(event) => {
              const scale = Number(event.target.value);
              setWorkpieceMillimetersPerUnit(scale);
              if (measurementSubjectFile)
                void loadMeasurementSubject(measurementSubjectFile, scale);
            }}
          >
            <option value={1}>millimetres</option>
            <option value={10}>centimetres</option>
            <option value={25.4}>inches</option>
            <option value={1_000}>metres / GLB</option>
          </select>
        </label>
        <small>{measurementSubjectMessage}</small>
        {measurementSubject && <div className="blend-measurement-actions">
          <button
            type="button"
            onClick={() => setPhysicalMeasurementMm(measurementSubject.dimensionsMm[0])}
          >Fit X span</button>
          <button type="button" onClick={() => {
            runtime.clearMeasurementSubject();
            setMeasurementSubject(null);
            setMeasurementSubjectFile(null);
            setMeasurementSubjectMessage("Optional · load a GLB, OBJ, or STL workpiece");
            setPointMeasurement({ points: [] });
          }}>Remove</button>
        </div>}
      </div>
      {batteryControl && <div className="blend-battery-control">
        <div><span>Battery insertion</span><output>{Math.round(batteryValue * 100)}%</output></div>
        <input
          type="range"
          min={batteryControl.min}
          max={batteryControl.max}
          step={batteryControl.step}
          value={batteryValue}
          onChange={(event) => setOverrides((current) => ({
            ...current,
            [batteryControl.identifier]: Number(event.target.value),
          }))}
        />
        <div className="blend-measurement-actions">
          <button type="button" onClick={() => setOverrides((current) => ({
            ...current,
            [batteryControl.identifier]: 0,
          }))}>Eject</button>
          <button type="button" onClick={() => setOverrides((current) => ({
            ...current,
            [batteryControl.identifier]: 1,
          }))}>Install</button>
        </div>
      </div>}
      <p className="blend-measurement-truth">
        {measurementContract.display
          ? "The modeled LCD is evaluated from reversible zero-offset and unit-scale Geometry Nodes added by BlendBridge. The source Blender graph remains untouched."
          : "This graph exposes jaw measurement but no traceable modeled LCD branch; mm/in and tare remain studio readout features."}
      </p>
    </section>}
    {gizmoContracts.length > 0 && <section>
      <div className="section-title">
        <span>Graph gizmos</span>
        <small>{gizmoContracts.length} bound</small>
      </div>
      <p className="blend-studio-copy">
        These controls follow Blender’s Linear and Dial gizmo links back to the
        root graph inputs, including nested groups and rotation components.
        Matching handles can also be dragged directly in the 3D viewport.
      </p>
      <div className="blend-controls">
        {gizmoContracts.map((contract) => {
          const raw = overrides[contract.rootInputIdentifier] ?? contract.rootValue;
          const value = contract.component === undefined
            ? Number(raw)
            : Number(Array.isArray(raw) ? raw[contract.component] : contract.value);
          const display = contract.kind === "dial"
            ? `${(value * 180 / Math.PI).toFixed(1)}°`
            : value.toFixed(3);
          return <label key={contract.id} title={`${contract.groupName} · ${contract.nodeName}`}>
            <span>{contract.rootInputName} · {contract.kind}</span>
            <input
              type="range"
              min={contract.min}
              max={contract.max}
              step={contract.step}
              value={value}
              onChange={(event) => setOverrides((current) =>
                setGizmoValue(current, contract, Number(event.target.value)))}
            />
            <output>{display}</output>
          </label>;
        })}
      </div>
    </section>}
    <section>
      <div className="section-title"><span>Exposed inputs</span><small>{visibleOrdinaryControls.length + visibleDatablockControls.length} editable</small></div>
      {hiddenControlCount > 0 && <label className="blend-hidden-toggle">
        <input
          type="checkbox"
          checked={showHiddenControls}
          onChange={(event) => setShowHiddenControls(event.target.checked)}
        />
        <span>Show {hiddenControlCount} Blender-hidden {hiddenControlCount === 1 ? "control" : "controls"}</span>
      </label>}
      <div className="blend-controls">
        {visibleOrdinaryControls.length === 0 && visibleDatablockControls.length === 0
          && <p>No additional portable inputs are exposed by this target.</p>}
        {controlPanelKeys.map((panelKey) => <div className="blend-control-panel" key={panelKey || "General"}>
          {panelKey && <h4>{panelKey}</h4>}
          {visibleOrdinaryControls
            .filter((control) => control.panelPath.join(" › ") === panelKey)
            .map((control) => <label key={control.identifier}>
              <span>{control.name}</span>
              {control.socketType === "NodeSocketBool"
                ? <input
                    type="checkbox"
                    checked={Boolean(overrides[control.identifier])}
                    onChange={(event) => setOverrides((current) => ({ ...current, [control.identifier]: event.target.checked }))}
                  />
                : control.socketType === "NodeSocketString"
                  ? <input
                      className="blend-string-input"
                      type="text"
                      value={String(overrides[control.identifier] ?? control.value)}
                      onChange={(event) => setOverrides((current) => ({ ...current, [control.identifier]: event.target.value }))}
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
          {visibleDatablockControls
            .filter((control) => control.panelPath.join(" › ") === panelKey)
            .map((control) => {
              const value = overrides[control.identifier] as { name?: string } | null | undefined;
              return <label key={control.identifier}>
                <span>{control.name}</span>
                <select
                  value={value?.name ?? ""}
                  onChange={(event) => setOverrides((current) => ({
                    ...current,
                    [control.identifier]: event.target.value
                      ? { datablock: control.datablock, name: event.target.value }
                      : null,
                  }))}
                >
                  <option value="">Unbound</option>
                  {control.options.map((name) =>
                    <option key={name} value={name}>{control.datablock} · {name}</option>)}
                </select>
              </label>;
            })}
        </div>)}
      </div>
    </section>
  </>;

  const rightDock = <>
    <header className="studio-dock-header"><span>Compatibility</span><small>static + executed</small></header>
    <section>
      <div className={`blend-runtime-status ${runtime.snapshot.state}${runtime.snapshot.preview ? " preview" : ""}`}>
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
      {autoEvaluation && <p className="blend-studio-copy">
        {autoEvaluation.reason}. {!autoEvaluation.enabled && "Use Apply to preview the partial result explicitly."}
        {progressivePreviewApplies && progressiveContract
          && ` Previews start with a quick low-${progressiveContract.control.name} pass and refine to full quality once you pause.`}
      </p>}
      <div className="blend-gaps">
        {compatibility.gaps.length
          ? compatibility.gaps.map((gap) => <span key={gap}>{gap}</span>)
          : <p>No statically unsupported nodes in this target closure.</p>}
      </div>
    </section>}
    {presetContract && <section>
      <div className="section-title"><span>Input contract</span><small>{presetContract.mode.replaceAll("-", " ")}</small></div>
      <p className="blend-studio-copy">{presetContract.reason}</p>
      {sourceUnits && <p className="blend-studio-copy">
        Scene units · {sourceUnits.system.toLowerCase()} · {sourceUnits.lengthUnit.toLowerCase().replaceAll("_", " ")}
        {" · "}{sourceUnits.millimetersPerBlenderUnit.toLocaleString()} mm per Blender unit
      </p>}
      {presetContract.unboundDatablockInputs.length > 0 && <div className="blend-gaps">
        {presetContract.unboundDatablockInputs.map((name) =>
          <span key={name}>Unbound datablock input · {name}</span>)}
      </div>}
    </section>}
    {(dependencySummary || extractionWarnings.length > 0) && <section>
      <div className="section-title">
        <span>Source packaging</span>
        <small>{dependencySummary
          ? `${dependencySummary.unresolved} unresolved`
          : `${extractionWarnings.length} warnings`}</small>
      </div>
      {dependencySummary && <div className="blend-packaging-summary">
        <span><b>{dependencySummary.fontsRecovered + dependencySummary.imagesRecovered}</b>recovered</span>
        <span><b>{dependencySummary.referenced}</b>extractable refs</span>
        <span className={dependencySummary.unresolved ? "warning" : ""}><b>{dependencySummary.unresolved}</b>unresolved</span>
      </div>}
      {extractionWarnings.length > 0 && <div className="blend-gaps">
        {extractionWarnings.slice(0, 8).map((warning, index) =>
          <span key={`${warning.code}:${index}`}>{warning.message}</span>)}
        {extractionWarnings.length > 8
          && <p>{extractionWarnings.length - 8} additional extraction warnings are retained in the exported JSON.</p>}
      </div>}
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
          : runtime.snapshot.pointStats
            ? <strong>{runtime.snapshot.pointStats.points.toLocaleString()} point-cloud points</strong>
          : <strong>Empty geometry output</strong>}
      <small>{runtime.snapshot.runtimeSeconds?.toFixed(2)}s in worker</small>
      {runtime.snapshot.preview && <em>Low-resolution preview · full quality refining</em>}
      {(runtime.snapshot.missingTypes ?? []).map((entry) =>
        <em key={entry.type}>{entry.type} ×{entry.count}</em>)}
      {(runtime.snapshot.approximateTypes ?? []).map((entry) =>
        <em key={entry.type}>Bounded approximation · {entry.type} ×{entry.count}</em>)}
    </section>}
    {(runtime.snapshot.details?.length ?? 0) > 0 && <section>
      <div className="section-title">
        <span>Runtime details</span>
        <small>{runtime.snapshot.details!.filter((detail) => detail.severity === "warning").length} warnings</small>
      </div>
      <div className="blend-runtime-details">
        {runtime.snapshot.details!.map((detail, index) =>
          <article className={detail.severity} key={`${detail.kind}:${detail.stage}:${index}`}>
            <b>{detail.kind === "volume-grid-budget"
              ? "Volume grid allocation"
              : detail.kind === "bounded-grid-adaptivity"
                ? "Bounded adaptivity"
                : `${detail.warningType} · ${detail.nodeName}`}</b>
            <span>{detail.stage.replaceAll("-", " ")}</span>
            <p>{detail.message}</p>
            {detail.kind === "volume-grid-budget" && <small>
              Requested {detail.requestedSampleCount.toLocaleString()} · effective {detail.effectiveSampleCount.toLocaleString()} · spacing {detail.effectiveSpacing.map((value) => value.toPrecision(4)).join(" × ")}
            </small>}
          </article>)}
      </div>
    </section>}
    <section className="blend-note">
      <span className="panel-label">Truth contract</span>
      <p>Static coverage means a handler exists. Only a Blender parity fixture proves that its behavior matches the authored tool.</p>
      <p>Failed edits retain the previous valid viewport result.</p>
    </section>
  </>;

  return <StudioShell
    eyebrow={libraryAsset ? "Asset library" : sourceName ? "Imported source" : "Procedural Studio"}
    title={sourceName || "Geometry Nodes Studio"}
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
      <button type="button" className="blend-empty-library" disabled={busy} onClick={() => setLibraryOpen(true)}>Browse the live asset library</button>
    </div>}
    {!graphOpen && workingDump && <button className="graph-toggle" type="button" onClick={() => setGraphOpen(true)}>{isMobile ? "Node graph" : "Show Geometry Nodes workspace"}</button>}
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
        {!isMobile && <button type="button" onClick={() => setGraphMaximized((maximized) => !maximized)}>{graphMaximized ? "Restore" : "Maximize"}</button>}
        <button type="button" onClick={() => { setGraphMaximized(false); setGraphOpen(false); }}>Hide</button>
      </>}
      onClose={() => { setGraphMaximized(false); setGraphOpen(false); }}
    >
      <GeometryNodesEditor
        config={editorConfig}
        source={graphSource}
        onDumpChange={setWorkingDump}
      />
    </FloatingStudioPanel>}
    <AssetLibraryOverlay
      open={libraryOpen}
      activeAssetId={libraryAsset?.id}
      onClose={() => setLibraryOpen(false)}
      onSelect={(asset) => void loadLibraryAsset(asset)}
    />
  </StudioShell>;
}
