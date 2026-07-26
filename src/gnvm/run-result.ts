import type { Geometry, TriSoup } from "./geometry";
import type { Vec3 } from "./core";

export interface RunCoverage {
  handled: number;
  missingTypes: { type: string; count: number }[];
  approximateTypes: { type: string; count: number }[];
}

export type RunDetailSeverity = "info" | "warning";

export type RunVolumeGridStage =
  | "volume-cube"
  | "volume-to-mesh"
  | "mesh-to-sdf-grid"
  | "points-to-sdf-grid"
  | "grid-to-mesh";

/**
 * Serializable execution details that complement node-type coverage.
 *
 * Coverage remains the stable support summary. Details describe decisions made
 * only at runtime, such as a dense-grid safety budget changing the requested
 * resolution or the browser's bounded Grid to Mesh adaptivity being active.
 */
export type RunDetail =
  | {
      kind: "volume-grid-budget";
      severity: RunDetailSeverity;
      stage: RunVolumeGridStage;
      message: string;
      adjusted: boolean;
      requestedSpacing: number;
      effectiveSpacing: Vec3;
      requestedSampleCount: number;
      effectiveSampleCount: number;
      sampleBudget: number;
    }
  | {
      kind: "bounded-grid-adaptivity";
      severity: "warning";
      stage: "grid-to-mesh";
      message: string;
      requestedAdaptivity: number;
      implementation: "dense-surface-net-decimation";
    }
  | {
      kind: "authored-node-warning";
      severity: RunDetailSeverity;
      stage: "geometry-node-warning";
      message: string;
      warningType: string;
      nodeName: string;
    };

export interface RunResult {
  geometry: Geometry;
  soup: TriSoup;
  coverage: RunCoverage;
  /** Additive runtime diagnostics; absent results from older callers remain valid. */
  details?: RunDetail[];
}
