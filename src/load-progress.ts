/**
 * Byte-level progress for the studio's status line.
 *
 * The baked assets are not small — `gallery/hat-front.glb` is 38 MB, and
 * several graph dumps are 22–33 MB. Every loader in the app used to set one
 * status string ("loading Blender bake…") and leave it there for the whole
 * transfer, so on a phone the wait was indistinguishable from a hang.
 */

/** 38.2 MB, 812 KB, 940 B — one decimal above a megabyte, none below. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/**
 * A progress suffix for `label`. `total` is 0 whenever the response arrives
 * without a Content-Length — compressed or chunked — so the transferred size
 * alone is reported rather than a percentage that would never reach 100.
 */
export function describeLoadProgress(label: string, loaded: number, total: number): string {
  if (total > 0) return `${label} ${Math.round((loaded / total) * 100)}% of ${formatBytes(total)}`;
  if (loaded > 0) return `${label} ${formatBytes(loaded)}`;
  return label;
}
