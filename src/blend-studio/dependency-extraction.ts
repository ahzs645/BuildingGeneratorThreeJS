import type { Dump, DumpImage, FontAtlas } from "../gnvm";
import type {
  DependencyAvailability,
  DependencyDescriptor,
  DependencyKind,
} from "../gnvm/dependency-metadata";

type FontSourceStatus =
  | "builtin"
  | "packed-extractable"
  | "packed-unreadable"
  | "external-available"
  | "external-missing"
  | "unknown";

type ExtractedFontAtlas = FontAtlas & {
  unavailable?: boolean;
  filepath?: string;
  atlas_status?: "embedded" | "unavailable" | "error" | "skipped" | "not-referenced";
  source?: {
    status?: FontSourceStatus;
    authored_filepath?: string;
    packed_size_bytes?: number;
    binary_extractable?: boolean;
  };
  packed_binary?: {
    included?: boolean;
    encoding?: "base64";
    byte_length?: number;
    sha256?: string;
    data?: string;
    error?: string;
  };
};

export type DependencyAssetKind = DependencyKind | "stl" | "other";

export interface DependencyAssetReference {
  kind: DependencyAssetKind;
  name: string;
  path?: string;
  availability: DependencyAvailability;
  reason?: string;
  sources: DependencyDescriptor["source"][];
}

export interface ExtractedFontEntry {
  name: string;
  atlasStatus: string;
  sourceStatus: FontSourceStatus;
  sourcePath?: string;
  glyphCount: number;
  payloadBytes: number;
  sha256: string;
  atlas: ExtractedFontAtlas;
}

export interface ExtractedImageEntry {
  name: string;
  sourcePath?: string;
  width: number;
  height: number;
  channels: number;
  encoding: "base64-rgba8";
  payloadBytes: number;
  sha256: string;
  pixelsRgba8: string;
}

export interface DependencyExtractionPackage {
  schemaVersion: 1;
  source: {
    filename?: string;
    fingerprintSha256?: string;
    blenderVersion?: string;
    extractor?: string;
    extractorVersion?: string;
  };
  fontAtlases: ExtractedFontEntry[];
  embeddedImages: ExtractedImageEntry[];
  referencedAssets: DependencyAssetReference[];
  missingAssets: DependencyAssetReference[];
  warnings: NonNullable<Dump["extraction_metadata"]>["warnings"];
  summary: {
    fontsRecovered: number;
    imagesRecovered: number;
    referenced: number;
    missing: number;
    unresolved: number;
    fontPayloadBytes: number;
    imagePayloadBytes: number;
    totalPayloadBytes: number;
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Dependency extraction requires Web Crypto SHA-256 support.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function base64Bytes(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++)
    bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function warningKind(code: string): DependencyAssetKind {
  if (code.includes("FONT")) return "font";
  if (code.includes("IMAGE")) return "image";
  if (code.includes("STL")) return "stl";
  return "other";
}

function sourceStatus(font: ExtractedFontAtlas): FontSourceStatus {
  const status = font.source?.status;
  return status ?? (font.unavailable ? "external-missing" : "unknown");
}

function descriptorSources(
  descriptors: readonly DependencyDescriptor[],
  kind: DependencyAssetKind,
  name: string,
): DependencyDescriptor["source"][] {
  return descriptors
    .filter((descriptor) => descriptor.kind === kind && descriptor.target.name === name)
    .map((descriptor) => ({ ...descriptor.source }));
}

function assetKey(asset: Pick<DependencyAssetReference, "kind" | "name" | "path">): string {
  return `${asset.kind}\u0000${asset.name}`;
}

function sortedAssets(assets: Iterable<DependencyAssetReference>): DependencyAssetReference[] {
  return [...assets].sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name)
    || (left.path ?? "").localeCompare(right.path ?? ""));
}

function mergeAsset(
  target: Map<string, DependencyAssetReference>,
  value: DependencyAssetReference,
): void {
  const key = assetKey(value);
  const current = target.get(key);
  if (!current) {
    target.set(key, value);
    return;
  }
  const sources = [...current.sources];
  for (const source of value.sources) {
    const serialized = stableJson(source);
    if (!sources.some((candidate) => stableJson(candidate) === serialized))
      sources.push(source);
  }
  target.set(key, {
    ...current,
    path: current.path ?? value.path,
    reason: current.reason ?? value.reason,
    sources,
  });
}

function imageMissing(
  image: DumpImage,
  warnings: readonly { code: string; path?: string[] }[],
): boolean {
  return warnings.some((warning) =>
    warning.code.includes("IMAGE")
    && warning.code.includes("UNAVAILABLE")
    && (warning.path?.[0] === image.name || warning.path?.includes(image.filepath ?? "")));
}

/**
 * Extract the portable dependency subset already recovered by Blender.
 *
 * This does not parse `.blend` bytes in the browser. The local Blender import
 * creates glyph atlases and RGBA payloads first; this client utility packages
 * those results and keeps unresolved external paths explicit.
 */
export async function dependencyExtractionPackage(
  dump: Dump,
): Promise<DependencyExtractionPackage> {
  const metadata = dump.extraction_metadata;
  const warnings = (metadata?.warnings ?? []).map((warning) => ({
    ...warning,
    ...(warning.path ? { path: [...warning.path] } : {}),
  }));
  const descriptors = metadata?.dependencies ?? [];
  const fontAtlases: ExtractedFontEntry[] = [];
  const embeddedImages: ExtractedImageEntry[] = [];
  const referenced = new Map<string, DependencyAssetReference>();
  const missing = new Map<string, DependencyAssetReference>();
  const encoder = new TextEncoder();

  for (const name of Object.keys(dump.fonts ?? {}).sort()) {
    const font = dump.fonts![name] as ExtractedFontAtlas;
    const glyphCount = Object.keys(font.glyphs ?? {}).length;
    const status = sourceStatus(font);
    const unavailable = font.unavailable === true
      || font.atlas_status === "unavailable"
      || status === "external-missing";
    if (!unavailable && !font.error && glyphCount > 0) {
      const serialized = encoder.encode(stableJson(font));
      fontAtlases.push({
        name,
        atlasStatus: font.atlas_status ?? "embedded",
        sourceStatus: status,
        ...(font.source?.authored_filepath
          ? { sourcePath: font.source.authored_filepath }
          : {}),
        glyphCount,
        payloadBytes: serialized.byteLength,
        sha256: await sha256(serialized),
        atlas: stableValue(font) as ExtractedFontAtlas,
      });
      continue;
    }
    const value: DependencyAssetReference = {
      kind: "font",
      name,
      ...(font.source?.authored_filepath || font.filepath
        ? { path: font.source?.authored_filepath ?? font.filepath }
        : {}),
      availability: unavailable ? "unavailable" : "referenced",
      reason: unavailable
        ? "The Blender file references this external font but does not contain its bytes or outlines."
        : font.error ?? "No portable glyph atlas was extracted.",
      sources: descriptorSources(descriptors, "font", name),
    };
    mergeAsset(unavailable ? missing : referenced, value);
  }

  for (const image of [...(dump.images ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name))) {
    if (image.pixels_rgba8) {
      const bytes = base64Bytes(image.pixels_rgba8);
      embeddedImages.push({
        name: image.name,
        ...(image.filepath ? { sourcePath: image.filepath } : {}),
        width: Number(image.size[0] ?? 0),
        height: Number(image.size[1] ?? 0),
        channels: Number(image.channels ?? 4),
        encoding: "base64-rgba8",
        payloadBytes: bytes.byteLength,
        sha256: await sha256(bytes),
        pixelsRgba8: image.pixels_rgba8,
      });
      continue;
    }
    if (!image.filepath) continue;
    const unavailable = imageMissing(image, warnings);
    mergeAsset(unavailable ? missing : referenced, {
      kind: "image",
      name: image.name,
      path: image.filepath,
      availability: unavailable ? "unavailable" : "referenced",
      reason: unavailable
        ? "The external image was unavailable during Blender extraction."
        : "The image remains an external reference and was not embedded in this extraction.",
      sources: descriptorSources(descriptors, "image", image.name),
    });
  }

  // Warnings also cover path-based dependencies such as Import STL that are
  // not represented by a Blender datablock descriptor.
  for (const warning of warnings) {
    if (!warning.code.includes("UNAVAILABLE")) continue;
    const kind = warningKind(warning.code);
    const name = kind === "stl" && (warning.path?.length ?? 0) >= 2
      ? `${warning.path![0]} / ${warning.path![1]}`
      : warning.path?.[0] ?? warning.message;
    const path = warning.path?.at(-1);
    mergeAsset(missing, {
      kind,
      name,
      ...(path && path !== name ? { path } : {}),
      availability: "unavailable",
      reason: warning.message,
      sources: descriptorSources(descriptors, kind, name),
    });
  }

  // Preserve explicit referenced/unavailable font and image descriptors even
  // when loading a legacy dump with no top-level payload entry.
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "font" && descriptor.kind !== "image") continue;
    if (descriptor.availability === "embedded") continue;
    const value: DependencyAssetReference = {
      kind: descriptor.kind,
      name: descriptor.target.name,
      ...(descriptor.target.library_path ? { path: descriptor.target.library_path } : {}),
      availability: descriptor.availability,
      reason: descriptor.availability === "unavailable"
        ? "Blender reported this dependency as unavailable."
        : "Blender retained this dependency as an external reference.",
      sources: [{ ...descriptor.source }],
    };
    mergeAsset(descriptor.availability === "unavailable" ? missing : referenced, value);
  }

  const fontPayloadBytes = fontAtlases.reduce((sum, entry) => sum + entry.payloadBytes, 0);
  const imagePayloadBytes = embeddedImages.reduce((sum, entry) => sum + entry.payloadBytes, 0);
  const referencedAssets = sortedAssets(referenced.values());
  const missingAssets = sortedAssets(missing.values());
  return {
    schemaVersion: 1,
    source: {
      ...(metadata?.source?.filename ? { filename: metadata.source.filename } : {}),
      ...(metadata?.source?.fingerprint_sha256
        ? { fingerprintSha256: metadata.source.fingerprint_sha256 }
        : {}),
      ...(dump.blender_version ? { blenderVersion: dump.blender_version } : {}),
      ...(metadata?.extractor?.name ? { extractor: metadata.extractor.name } : {}),
      ...(metadata?.extractor?.version ? { extractorVersion: metadata.extractor.version } : {}),
    },
    fontAtlases,
    embeddedImages,
    referencedAssets,
    missingAssets,
    warnings,
    summary: {
      fontsRecovered: fontAtlases.length,
      imagesRecovered: embeddedImages.length,
      referenced: referencedAssets.length,
      missing: missingAssets.length,
      unresolved: referencedAssets.length + missingAssets.length,
      fontPayloadBytes,
      imagePayloadBytes,
      totalPayloadBytes: fontPayloadBytes + imagePayloadBytes,
    },
  };
}
