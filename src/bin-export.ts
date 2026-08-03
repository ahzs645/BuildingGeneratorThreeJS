import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

export const BIN_EXPORT_METADATA_VERSION = "2026-08-02";

export type BinExportEngine = "vm" | "blender";
export type BinTruthSource = "live" | "baked" | "unavailable";

export type BinExportMetadata = {
  asset: "Recursive Bin";
  parameters: Record<string, number | boolean>;
  engine: "Blender" | "GN-VM";
  truthSource: BinTruthSource;
  blenderVersion: string;
  classification: string;
  comparedParameters: Record<string, number | boolean> | null;
  evidence: string;
  evidenceVersion: string;
};

export function makeBinExportMetadata(options: {
  parameters: Record<string, number | boolean>;
  engine: BinExportEngine;
  truthSource: BinTruthSource;
  classification: string;
  comparedParameters: Record<string, number | boolean> | null;
  evidence: string;
  blenderVersion?: string;
}): BinExportMetadata {
  return {
    asset: "Recursive Bin",
    parameters: { ...options.parameters },
    engine: options.engine === "blender" ? "Blender" : "GN-VM",
    truthSource: options.truthSource,
    blenderVersion: options.blenderVersion ?? "5.1.2",
    classification: options.classification,
    comparedParameters: options.comparedParameters ? { ...options.comparedParameters } : null,
    evidence: options.evidence,
    evidenceVersion: BIN_EXPORT_METADATA_VERSION,
  };
}

/**
 * Encode the evaluated result, independent of its current viewport visibility.
 * The same metadata offered as the JSON sidecar is embedded in glTF `extras`
 * on the exported root so a GLB remains self-describing when shared alone.
 */
export async function encodeBinGlb(
  root: THREE.Object3D,
  metadata: BinExportMetadata,
): Promise<ArrayBuffer> {
  const exportRoot = root.clone(true);
  exportRoot.userData = {
    ...exportRoot.userData,
    recursiveBin: metadata,
  };
  const result = await new GLTFExporter().parseAsync(exportRoot, {
    binary: true,
    // Visibility is a comparison-UI concern. In particular, Blender truth is
    // hidden while the Build workspace shows GN-VM, but must still download.
    onlyVisible: false,
  });
  if (!(result instanceof ArrayBuffer)) throw new Error("GLB exporter returned JSON instead of binary data");
  return result;
}

/** STL is geometry-only: it retains triangles and world transforms, not metadata or materials. */
export function encodeBinStl(root: THREE.Object3D): ArrayBuffer {
  root.updateMatrixWorld(true);
  const result: unknown = new STLExporter().parse(root, { binary: true });
  if (result instanceof ArrayBuffer) return result;
  if (ArrayBuffer.isView(result)) {
    return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
  }
  throw new Error("STL exporter returned text instead of binary data");
}

export function encodeBinMetadata(metadata: BinExportMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
