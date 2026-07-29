import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { publicUrl } from "../../base-url";
import "./asset-library.css";

/** One ported asset from the Node Dojo chrome-assets catalog. */
export type LibraryAsset = {
  id: string;
  title: string;
  object: string;
  dump: string;
  shaderMetadata?: string;
  reference: string;
  authoredReference?: string;
  blenderStats: { verts: number; faces: number; triangles?: number };
  curveStats?: { controlPoints: number; evaluatedPoints?: number; segments?: number };
  note?: string;
};

// The catalog is immutable per deploy; share one fetch across every mount and
// keep it after the overlay closes so reopening is instant.
let catalogPromise: Promise<LibraryAsset[]> | null = null;

export function fetchAssetCatalog(): Promise<LibraryAsset[]> {
  catalogPromise ??= fetch(publicUrl("dojo/chrome-assets/catalog.json"), { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`Asset catalog failed (${response.status})`);
      return response.json() as Promise<LibraryAsset[]>;
    })
    .catch((error: unknown) => {
      catalogPromise = null;
      throw error;
    });
  return catalogPromise;
}

export function libraryAssetStats(asset: LibraryAsset): string {
  return asset.curveStats
    ? `${asset.curveStats.controlPoints.toLocaleString()} curve points`
    : `${asset.blenderStats.verts.toLocaleString()} verts · ${asset.blenderStats.faces.toLocaleString()} faces`;
}

type AssetLibraryOverlayProps = {
  open: boolean;
  activeAssetId?: string;
  onClose: () => void;
  onSelect: (asset: LibraryAsset) => void;
};

/**
 * Full-screen browser for the ported asset catalog: every asset is shown as
 * its Blender reference render so the library can be scanned visually instead
 * of through a name search. Selecting an asset hands it to the studio.
 */
export function AssetLibraryOverlay({ open, activeAssetId, onClose, onSelect }: AssetLibraryOverlayProps): React.JSX.Element | null {
  const [catalog, setCatalog] = useState<LibraryAsset[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open || catalog) return;
    let cancelled = false;
    setError("");
    fetchAssetCatalog().then(
      (items) => { if (!cancelled) setCatalog(items); },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => { cancelled = true; };
  }, [catalog, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const visible = useMemo(() => {
    if (!catalog) return [];
    const needle = filter.trim().toLocaleLowerCase();
    if (!needle) return catalog;
    return catalog.filter((asset) =>
      [asset.title, asset.id, asset.object].some((field) => field.toLocaleLowerCase().includes(needle)));
  }, [catalog, filter]);

  if (!open) return null;
  // Portaled to <body> like StudioMenu: the trigger lives inside fixed studio
  // chrome whose backdrop-filter would otherwise contain this fixed overlay.
  return createPortal(
    <div className="asset-library-backdrop" onClick={onClose} role="presentation">
      <section className="asset-library" aria-label="Live asset library" onClick={(event) => event.stopPropagation()}>
        <header>
          <b>Live Asset Library</b>
          <input
            type="search"
            autoFocus
            placeholder={catalog ? `Search ${catalog.length} ported assets…` : "Search ported assets…"}
            aria-label="Search ported assets"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button type="button" onClick={onClose}>Close ✕</button>
        </header>
        {error && <p className="asset-library-message asset-library-error">{error}</p>}
        {!catalog && !error && <p className="asset-library-message">Loading catalog…</p>}
        {catalog && <div className="asset-library-grid">
          {visible.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={asset.id === activeAssetId ? "current" : ""}
              aria-current={asset.id === activeAssetId ? "true" : undefined}
              onClick={() => onSelect(asset)}
            >
              <img loading="lazy" src={publicUrl(asset.authoredReference ?? asset.reference)} alt={`${asset.title} Blender reference render`} />
              <b>{asset.title}</b>
              <small>{libraryAssetStats(asset)}</small>
            </button>
          ))}
          {!visible.length && <p className="asset-library-message">No assets match “{filter}”.</p>}
        </div>}
        <footer>Blender reference renders · selecting an asset loads its extracted Geometry Nodes graph into the studio to edit and evaluate.</footer>
      </section>
    </div>,
    document.body,
  );
}
