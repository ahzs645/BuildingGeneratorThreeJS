import assert from "node:assert/strict";
import test from "node:test";
import { runtimeDetailsFromVolumeGridDiagnostics } from "./runtime-details";

const base = {
  stage: "mesh-to-sdf-grid" as const,
  background: 1,
  min: [0, 0, 0] as [number, number, number],
  max: [10, 10, 10] as [number, number, number],
  resolution: [100, 100, 100] as [number, number, number],
  origin: [0, 0, 0] as [number, number, number],
  spacing: [.1, .1, .1] as [number, number, number],
  requestedSpacing: .05,
  requestedSampleCount: 8_000_000,
  sampleCount: 1_000_000,
  sampleBudget: 1_000_000,
  budgetAdjusted: true,
  values: new Float32Array(0),
};

test("turns a coarsened dense volume allocation into a serializable warning", () => {
  const [detail] = runtimeDetailsFromVolumeGridDiagnostics(base);
  assert.deepEqual(detail, {
    kind: "volume-grid-budget",
    severity: "warning",
    stage: "mesh-to-sdf-grid",
    message: "Dense volume grid was resampled from 8,000,000 requested samples to 1,000,000 within the 1,000,000 sample browser budget.",
    adjusted: true,
    requestedSpacing: .05,
    effectiveSpacing: [.1, .1, .1],
    requestedSampleCount: 8_000_000,
    effectiveSampleCount: 1_000_000,
    sampleBudget: 1_000_000,
  });
});

test("reports active bounded Grid to Mesh adaptivity alongside allocation detail", () => {
  const details = runtimeDetailsFromVolumeGridDiagnostics({
    ...base,
    stage: "grid-to-mesh",
    budgetAdjusted: false,
    requestedSampleCount: 1_000_000,
    requestedAdaptivity: .5,
    adaptivityApplied: true,
  });
  assert.equal(details[0].severity, "info");
  assert.deepEqual(details[1], {
    kind: "bounded-grid-adaptivity",
    severity: "warning",
    stage: "grid-to-mesh",
    message: "Grid to Mesh used bounded dense surface-net decimation at adaptivity 0.5; intermediate topology is not exact OpenVDB parity.",
    requestedAdaptivity: .5,
    implementation: "dense-surface-net-decimation",
  });
});

test("reports bounded Volume to Mesh adaptivity instead of hiding the fallback mode", () => {
  const details = runtimeDetailsFromVolumeGridDiagnostics({
    ...base,
    stage: "volume-to-mesh",
    budgetAdjusted: false,
    requestedSampleCount: 1_000_000,
    requestedAdaptivity: .25,
    adaptivityApplied: true,
  });
  assert.deepEqual(details[1], {
    kind: "bounded-grid-adaptivity",
    severity: "warning",
    stage: "volume-to-mesh",
    message: "Volume to Mesh used bounded dense surface-net decimation at adaptivity 0.25; intermediate topology is not exact OpenVDB parity.",
    requestedAdaptivity: .25,
    implementation: "dense-surface-net-decimation",
  });
});
