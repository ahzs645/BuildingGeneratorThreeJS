import { decompress as zstdDecompress } from "fzstd";

/** Container Blender wrapped the raw DNA stream in. */
export type BlendEnvelope = "raw" | "gzip" | "zstd";

const BLENDER_MAGIC = [0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52];

/** Identify the envelope from the first bytes, or null when nothing matches. */
export function blendEnvelope(bytes: Uint8Array): BlendEnvelope | null {
  if (BLENDER_MAGIC.every((byte, index) => bytes[index] === byte)) return "raw";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return "zstd";
  return null;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const decompression = new DecompressionStream("gzip");
  const source = new Uint8Array(bytes);
  const stream = new Blob([source]).stream().pipeThrough(decompression);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Unwrap a `.blend` file into the raw DNA stream.
 *
 * Blender writes zstd as a *seekable* stream: several independent frames plus a
 * trailing skippable frame holding the seek table. `fzstd` walks concatenated
 * frames and ignores skippable ones, so the whole file decodes in one pass.
 */
export async function decompressBlend(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; envelope: BlendEnvelope }> {
  const envelope = blendEnvelope(bytes);
  if (!envelope) throw new Error("This file does not have a recognized Blender or compressed Blender header.");
  if (envelope === "raw") return { bytes, envelope };
  const decoded = envelope === "zstd" ? zstdDecompress(bytes) : await gunzip(bytes);
  if (blendEnvelope(decoded) !== "raw") {
    throw new Error(`The ${envelope} payload does not contain a Blender file header.`);
  }
  return { bytes: decoded, envelope };
}
