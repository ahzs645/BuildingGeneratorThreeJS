import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { appHref } from "../base-url";
import { StudioNav } from "./studio/StudioNav";
import "./shell.css";

const BlendBridgePage = lazy(() => import("./pages/BlendBridgePage"));
const BuildingPage = lazy(() => import("./pages/BuildingPage"));
const DojoViewerPage = lazy(() => import("./pages/DojoViewerPage"));
const DojoGalleryPage = lazy(() => import("./pages/DojoGalleryPage"));
const BinComparePage = lazy(() => import("./pages/BinComparePage"));
const BinLivePage = lazy(() => import("./pages/BinLivePage"));
const VaseComparePage = lazy(() => import("./pages/VaseComparePage"));
const CrayonComparePage = lazy(() => import("./pages/CrayonComparePage"));
const TypewriterPage = lazy(() => import("./pages/TypewriterPage"));
const PeriodicBrushPage = lazy(() => import("./pages/PeriodicBrushPage"));
const ChromeAssetsPage = lazy(() => import("./pages/ChromeAssetsPage"));
const SurfacePaintPage = lazy(() => import("./pages/SurfacePaintPage"));
const MaterialXLabPage = lazy(() => import("./pages/MaterialXLabPage"));

// Old entry points (pre-router .html files, renamed routes, and the three
// painting tools now unified under /paint) → current routes. Incoming query
// params are preserved; params baked into the target act as defaults.
const LEGACY_ROUTES: Record<string, string> = {
  "/blendbridge": "/",
  "/gnvm": "/bin",
  "/vegetation-generator": "/paint?mode=ivy",
  "/geometry-painter": "/paint?mode=crystals",
  "/surface-draw": "/paint?engine=blender",
  "/blend-import.html": "/",
  "/building.html": "/building",
  "/dojo-viewer.html": "/dojo",
  "/dojo-gallery.html": "/gallery",
  "/bin-studio.html": "/bin",
  "/bin-live.html": "/bin/live",
  "/gnvm-viewer.html": "/bin",
  "/vase-compare.html": "/vase",
  "/geometry-painter.html": "/paint?mode=crystals",
  "/vegetation-generator.html": "/paint?mode=ivy",
};

function LegacyRedirect({ to }: { to: string }): React.JSX.Element {
  const { search } = useLocation();
  const [path, targetQuery] = to.split("?");
  const params = new URLSearchParams(search);
  if (targetQuery) {
    for (const [key, value] of new URLSearchParams(targetQuery)) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  const query = params.toString();
  return <Navigate replace to={`${path}${query ? `?${query}` : ""}`} />;
}

function NotFound(): React.JSX.Element {
  return <main className="not-found"><div><h1>That studio route does not exist.</h1><p><a href={appHref()}>Return to Procedural Studio</a></p></div></main>;
}

function StudioRoutes(): React.JSX.Element {
  const location = useLocation();
  return (
    // Keyed by path + search: tool pages must remount (fresh canvas, fresh
    // runtime) on ANY router navigation, including query-only preset links —
    // dispose() force-loses the old canvas's GL context, so a runtime can
    // never be rebuilt on a canvas that React kept alive.
    <Routes location={location} key={`${location.pathname}?${location.search}`}>
          <Route path="/" element={<BlendBridgePage />} />
          <Route path="/building" element={<BuildingPage />} />
          <Route path="/dojo" element={<DojoViewerPage />} />
          <Route path="/gallery" element={<DojoGalleryPage />} />
          <Route path="/bin" element={<BinComparePage />} />
          <Route path="/bin/live" element={<BinLivePage />} />
          <Route path="/vase" element={<VaseComparePage />} />
          <Route path="/crayon" element={<CrayonComparePage />} />
          <Route path="/typewriter" element={<TypewriterPage />} />
          <Route path="/periodic-brush" element={<PeriodicBrushPage />} />
          <Route path="/chrome-assets" element={<ChromeAssetsPage />} />
          <Route path="/paint" element={<SurfacePaintPage />} />
          <Route path="/materialx" element={<MaterialXLabPage />} />

          {Object.entries(LEGACY_ROUTES).map(([from, to]) =>
            <Route key={from} path={from} element={<LegacyRedirect to={to} />} />)}
          <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App(): React.JSX.Element {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      {/* Outside the keyed Routes: the nav bar survives every navigation. */}
      <StudioNav />
      <Suspense fallback={<div className="route-loading">Loading procedural tool…</div>}>
        <StudioRoutes />
      </Suspense>
    </BrowserRouter>
  );
}
