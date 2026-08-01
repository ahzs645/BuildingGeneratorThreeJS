import type { VolumeGridDiagnostics } from "./nodes/volume";
import { setVolumeGridDiagnosticSink } from "./nodes/volume";
import type { RunDetail } from "./run-result";

let details: RunDetail[] = [];

/** Record one typed diagnostic while a GN-VM evaluation is active. */
export function recordRuntimeDetail(detail: RunDetail): void {
  const duplicate = details.some((candidate) =>
    candidate.kind === detail.kind
    && candidate.message === detail.message
    && (
      candidate.kind !== "authored-node-warning"
      || detail.kind !== "authored-node-warning"
      || candidate.nodeName === detail.nodeName
    ));
  if (!duplicate) details.push(detail);
}

function integer(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : fallback;
}

function decimal(value: number): string {
  if (value >= 1) return value.toFixed(3).replace(/\.?0+$/, "");
  return value.toPrecision(4).replace(/\.?0+$/, "");
}

function volumeGridDetails(diagnostic: VolumeGridDiagnostics): RunDetail[] {
  const effectiveSampleCount = integer(
    diagnostic.sampleCount,
    diagnostic.resolution[0] * diagnostic.resolution[1] * diagnostic.resolution[2],
  );
  const requestedSampleCount = integer(diagnostic.requestedSampleCount, effectiveSampleCount);
  const sampleBudget = integer(diagnostic.sampleBudget, effectiveSampleCount);
  const requestedSpacing = Number.isFinite(diagnostic.requestedSpacing)
    ? Math.max(0, diagnostic.requestedSpacing!)
    : Math.max(...diagnostic.spacing);
  const adjusted = diagnostic.budgetAdjusted === true;
  const allocationMessage = adjusted
    ? `Dense volume grid was resampled from ${requestedSampleCount.toLocaleString("en-US")} requested samples to ${effectiveSampleCount.toLocaleString("en-US")} within the ${sampleBudget.toLocaleString("en-US")} sample browser budget.`
    : `Dense volume grid used ${effectiveSampleCount.toLocaleString("en-US")} samples within the ${sampleBudget.toLocaleString("en-US")} sample browser budget.`;
  const result: RunDetail[] = [{
    kind: "volume-grid-budget",
    severity: adjusted ? "warning" : "info",
    stage: diagnostic.stage,
    message: allocationMessage,
    adjusted,
    requestedSpacing,
    effectiveSpacing: [...diagnostic.spacing],
    requestedSampleCount,
    effectiveSampleCount,
    sampleBudget,
  }];

  const adaptivity = diagnostic.requestedAdaptivity ?? 0;
  if (
    (diagnostic.stage === "grid-to-mesh" || diagnostic.stage === "volume-to-mesh")
    && adaptivity > 0
    && diagnostic.adaptivityApplied === true
  ) {
    const label = diagnostic.stage === "grid-to-mesh" ? "Grid to Mesh" : "Volume to Mesh";
    result.push({
      kind: "bounded-grid-adaptivity",
      severity: "warning",
      stage: diagnostic.stage,
      message: `${label} used bounded dense surface-net decimation at adaptivity ${decimal(adaptivity)}; intermediate topology is not exact OpenVDB parity.`,
      requestedAdaptivity: adaptivity,
      implementation: "dense-surface-net-decimation",
    });
  }
  return result;
}

const collectVolumeGridDetails = (diagnostic: VolumeGridDiagnostics): void => {
  for (const detail of volumeGridDetails(diagnostic)) recordRuntimeDetail(detail);
};

// Install the Studio/API collector by default without taking ownership during
// each run. Full-precision parity tools intentionally replace this process-local
// sink after importing GNVM; runGenerator must not overwrite their callback.
setVolumeGridDiagnosticSink(collectVolumeGridDetails);

/** Begin collecting serializable runtime details for one GNVM evaluation. */
export function beginRuntimeDetailCollection(): void {
  details = [];
}

/** Snapshot details collected by the active evaluation. */
export function runtimeDetailSnapshot(): RunDetail[] {
  return details.map((detail) => ({
    ...detail,
    ...(detail.kind === "volume-grid-budget"
      ? { effectiveSpacing: [...detail.effectiveSpacing] }
      : {}),
  })) as RunDetail[];
}

/** Mark the evaluation boundary. The default collector remains installed. */
export function endRuntimeDetailCollection(): void {
  // Intentionally empty. Parity tooling owns the sink when it replaces it.
}

export const runtimeDetailsFromVolumeGridDiagnostics = volumeGridDetails;
