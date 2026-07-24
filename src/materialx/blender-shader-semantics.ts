/** Blender shader-node semantics shared by extracted MaterialX probes. */

export function blenderDielectricFresnel(cosine: number, eta: number): number {
  const c = Math.abs(cosine);
  const gSquared = eta * eta - 1 + c * c;
  if (gSquared <= 0) return 1;
  const g = Math.sqrt(gSquared);
  const a = (g - c) / (g + c);
  const b = (c * (g + c) - 1) / (c * (g - c) + 1);
  return 0.5 * a * a * (1 + b * b);
}

/**
 * Cycles' Layer Weight Fresnel output.
 *
 * Front faces use eta = 1 / max(1 - blend, 1e-5); back faces use the
 * unreversed eta. This mirrors Blender's bundled SVM and OSL implementations.
 */
export function blenderLayerWeightFresnel(
  cosine: number,
  blend: number,
  backfacing = false,
): number {
  const baseEta = Math.max(1 - blend, 1e-5);
  return blenderDielectricFresnel(cosine, backfacing ? baseEta : 1 / baseEta);
}

/**
 * Blender Mix Color in MULTIPLY mode with factor F:
 * mix(base, base * response, F).
 */
export function blenderRoughnessFresnel(
  baseRoughness: number,
  fresnel: number,
  response: number,
): number {
  return baseRoughness * (1 - fresnel + fresnel * response);
}

/** Center-corrected coordinate for a linearly filtered N-sample 1D LUT. */
export function blenderScalarLutCoordinate(factor: number, sampleCount: number): number {
  if (!Number.isInteger(sampleCount) || sampleCount < 2) {
    throw new Error(`Scalar LUT requires at least two samples; received ${sampleCount}`);
  }
  return factor * (sampleCount - 1) / sampleCount + 0.5 / sampleCount;
}

/** CPU equivalent of the centered, clamped, linearly filtered scalar LUT. */
export function sampleBlenderScalarLut(samples: readonly number[], factor: number): number {
  if (samples.length < 2) {
    throw new Error(`Scalar LUT requires at least two samples; received ${samples.length}`);
  }
  const position = Math.min(1, Math.max(0, factor)) * (samples.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(samples.length - 1, lower + 1);
  const weight = position - lower;
  return samples[lower] * (1 - weight) + samples[upper] * weight;
}
