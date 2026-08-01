import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { publicUrl } from "../../base-url";
import { useModalDialog } from "../studio/useModalDialog";
import {
  LIBRARY_ASSET_CATEGORIES,
  libraryAssetCategory,
  type LibraryAsset,
  type LibraryAssetCategory,
} from "./asset-library-model";
import "./asset-library.css";

export { libraryAssetCompareHref, type LibraryAsset } from "./asset-library-model";

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
  const [category, setCategory] = useState<LibraryAssetCategory | "All">("All");
  const [view, setView] = useState<"all" | "recent" | "favorites">("all");
  const [recent, setRecent] = useState<string[]>(() => readStoredIds("studio-recent-assets"));
  const [favorites, setFavorites] = useState<string[]>(() => readStoredIds("studio-favorite-assets"));
  const dialogRef = useModalDialog<HTMLElement>(open, onClose, "[data-asset-search]");

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

  const visible = useMemo(() => {
    if (!catalog) return [];
    const needle = filter.trim().toLocaleLowerCase();
    let items = category === "All" ? catalog : catalog.filter((asset) => libraryAssetCategory(asset) === category);
    if (view === "recent") {
      const order = new Map(recent.map((id, index) => [id, index]));
      items = items.filter((asset) => order.has(asset.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    } else if (view === "favorites") {
      const saved = new Set(favorites);
      items = items.filter((asset) => saved.has(asset.id));
    }
    if (!needle) return items;
    return items.filter((asset) =>
      [asset.title, asset.id, asset.object].some((field) => field.toLocaleLowerCase().includes(needle)));
  }, [catalog, category, favorites, filter, recent, view]);

  const selectAsset = (asset: LibraryAsset): void => {
    const next = [asset.id, ...recent.filter((id) => id !== asset.id)].slice(0, 12);
    setRecent(next);
    localStorage.setItem("studio-recent-assets", JSON.stringify(next));
    onSelect(asset);
  };

  const toggleFavorite = (assetId: string): void => {
    const next = favorites.includes(assetId)
      ? favorites.filter((id) => id !== assetId)
      : [assetId, ...favorites];
    setFavorites(next);
    localStorage.setItem("studio-favorite-assets", JSON.stringify(next));
  };

  if (!open) return null;
  // Portaled to <body> like StudioMenu: the trigger lives inside fixed studio
  // chrome whose backdrop-filter would otherwise contain this fixed overlay.
  return createPortal(
    <div className="asset-library-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className="asset-library"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-library-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <b id="asset-library-title">Asset Browser</b>
          <input
            type="search"
            data-asset-search
            placeholder={catalog ? `Search ${catalog.length} ported assets…` : "Search ported assets…"}
            aria-label="Search ported assets"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button type="button" onClick={onClose}>Close ✕</button>
        </header>
        <div className="asset-library-filters" aria-label="Asset filters">
          <div className="asset-library-categories">
            {(["All", ...LIBRARY_ASSET_CATEGORIES] as const).map((item) => <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >{item}</button>)}
          </div>
          <div className="asset-library-views">
            <button type="button" aria-pressed={view === "recent"} onClick={() => setView(view === "recent" ? "all" : "recent")}>Recent</button>
            <button type="button" aria-pressed={view === "favorites"} onClick={() => setView(view === "favorites" ? "all" : "favorites")}>★ Favorites</button>
            <span>{visible.length} shown</span>
          </div>
        </div>
        {error && <p className="asset-library-message asset-library-error">{error}</p>}
        {!catalog && !error && <p className="asset-library-message">Loading catalog…</p>}
        {catalog && <div className="asset-library-grid">
          {visible.map((asset) => (
            <article key={asset.id} className={asset.id === activeAssetId ? "current" : ""}>
              <button
                type="button"
                className="asset-library-card"
                aria-current={asset.id === activeAssetId ? "true" : undefined}
                onClick={() => selectAsset(asset)}
              >
                <img loading="lazy" src={publicUrl(asset.authoredReference ?? asset.reference)} alt={`${asset.title} Blender reference render`} />
                <b>{asset.title}</b>
                <small>{libraryAssetCategory(asset)} · {libraryAssetStats(asset)}</small>
              </button>
              <button
                type="button"
                className="asset-library-favorite"
                aria-label={`${favorites.includes(asset.id) ? "Remove" : "Add"} ${asset.title} ${favorites.includes(asset.id) ? "from" : "to"} favorites`}
                aria-pressed={favorites.includes(asset.id)}
                onClick={() => toggleFavorite(asset.id)}
              >★</button>
            </article>
          ))}
          {!visible.length && <p className="asset-library-message">No assets match “{filter}”.</p>}
        </div>}
        <footer>Blender reference renders · selecting an asset loads its extracted Geometry Nodes graph into the studio to edit and evaluate.</footer>
      </section>
    </div>,
    document.body,
  );
}

function readStoredIds(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}
