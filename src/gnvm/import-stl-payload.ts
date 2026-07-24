import type { Vec3 } from "./core";
import type { RawNode } from "./dump-schema";

export const MAX_EMBEDDED_STL_BYTES = 32 * 1024 * 1024;
export const MAX_EMBEDDED_STL_TRIANGLES = 200_000;

export interface EmbeddedStlPayload {
  version: 1;
  format: "ascii" | "binary";
  source_size_bytes: number;
  source_sha256: string;
  triangle_count: number;
  positions: Vec3[];
  faces: [number, number, number][];
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return Array.isArray(value)
    && value.length === 3
    && value.every((component) => typeof component === "number" && Number.isFinite(component));
}

/**
 * Validate the complete extraction contract before static analysis or runtime
 * trusts a dump. In particular, faces must retain the parser's triangle-soup
 * order; arbitrary indices from hand-edited/untrusted JSON are not accepted.
 */
export function embeddedStlPayloadOf(node: RawNode): EmbeddedStlPayload | null {
  const payload = node.embedded_stl;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Partial<EmbeddedStlPayload>;
  if (
    candidate.version !== 1
    || (candidate.format !== "ascii" && candidate.format !== "binary")
    || !Number.isInteger(candidate.source_size_bytes)
    || Number(candidate.source_size_bytes) < 0
    || Number(candidate.source_size_bytes) > MAX_EMBEDDED_STL_BYTES
    || typeof candidate.source_sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(candidate.source_sha256)
    || !Number.isInteger(candidate.triangle_count)
    || Number(candidate.triangle_count) < 0
    || Number(candidate.triangle_count) > MAX_EMBEDDED_STL_TRIANGLES
    || !Array.isArray(candidate.positions)
    || !Array.isArray(candidate.faces)
    || candidate.positions.length !== Number(candidate.triangle_count) * 3
    || candidate.faces.length !== Number(candidate.triangle_count)
    || !candidate.positions.every(isFiniteVec3)
  ) return null;
  for (let triangle = 0; triangle < candidate.faces.length; triangle++) {
    const face = candidate.faces[triangle];
    const first = triangle * 3;
    if (
      !Array.isArray(face)
      || face.length !== 3
      || face[0] !== first
      || face[1] !== first + 1
      || face[2] !== first + 2
    ) return null;
  }
  return candidate as EmbeddedStlPayload;
}

export function hasEmbeddedStlPayload(node: RawNode): boolean {
  return embeddedStlPayloadOf(node) !== null;
}
