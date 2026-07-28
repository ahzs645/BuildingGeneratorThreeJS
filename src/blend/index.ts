import { blendEnvelope, decompressBlend, type BlendEnvelope } from "./decompress";
import { readBlendFile, type BlendFile } from "./blend-file";
import { buildPortableDump, type DecodedBlend, type PortableGap } from "./to-dump";

export { blendEnvelope, decompressBlend, readBlendFile, buildPortableDump };
export type { BlendEnvelope, BlendFile, DecodedBlend, PortableGap };
export type { BlendBlock, BlendHeader, BlendStruct } from "./blend-file";
export type { Sdna, SdnaField, SdnaStruct } from "./sdna";

/**
 * Turn `.blend` bytes into the portable node dump the browser runtime consumes.
 *
 * This is the client-side counterpart to `tools/dump_blend.py`: it reads the
 * file's own DNA catalogue instead of asking Blender, so it runs anywhere a
 * `Uint8Array` does. Anything that genuinely needs Blender to evaluate — base
 * meshes, image pixels, font outlines, RNA enum identifiers — is reported in
 * `gaps` rather than approximated.
 */
export async function decodeBlend(
  bytes: Uint8Array,
  meta: { filename?: string } = {},
): Promise<DecodedBlend> {
  const { bytes: raw, envelope } = await decompressBlend(bytes);
  const file = readBlendFile(raw);
  return buildPortableDump(file, { ...meta, bytes: bytes.length, envelope });
}
