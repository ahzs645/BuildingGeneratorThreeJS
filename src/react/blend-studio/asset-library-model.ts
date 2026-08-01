/** One ported asset from the shared Node Dojo catalog. */
export type LibraryAsset = {
  id: string;
  title: string;
  object: string;
  dump: string;
  compareHref?: string;
  shaderMetadata?: string;
  reference: string;
  authoredReference?: string;
  blenderStats: { verts: number; faces: number; triangles?: number };
  curveStats?: { controlPoints: number; evaluatedPoints?: number; segments?: number };
  note?: string;
};

export const LIBRARY_ASSET_CATEGORIES = ["Drawing", "Text", "Stickers", "Fabrication", "Studies", "Scenes"] as const;
export type LibraryAssetCategory = typeof LIBRARY_ASSET_CATEGORIES[number];

/** Stable catalog grouping until category metadata is added to the extraction manifest. */
export function libraryAssetCategory(asset: LibraryAsset): LibraryAssetCategory {
  const haystack = `${asset.id} ${asset.title} ${asset.object}`.toLocaleLowerCase();
  if (/text|typewriter/.test(haystack)) return "Text";
  if (/sticker|stickie|pack shape/.test(haystack)) return "Stickers";
  if (/crayon|marker|brush|stippler/.test(haystack)) return "Drawing";
  if (/math clay|the nodes node/.test(haystack)) return "Studies";
  if (/course|send nodes hat/.test(haystack)) return "Scenes";
  return "Fabrication";
}

export function libraryAssetCompareHref(asset: LibraryAsset): string {
  return asset.compareHref ?? `/chrome-assets?asset=${encodeURIComponent(asset.id)}`;
}
