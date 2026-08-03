// The shared shell + control kit, first: CSS is injected in module-evaluation
// order, so every other stylesheet in the app — the nav's own overrides, the
// shell's, and each lazily imported page's — loads after it and can override
// kit rules at equal specificity. Never move this below a component import.
import "./studio/studio-kit.css";
import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { appHref } from "../base-url";
import { StudioChromeProvider } from "./studio/StudioChrome";
import { StudioNav } from "./studio/StudioNav";
import "./shell.css";

const BlendBridgePage = lazy(() => import("./pages/BlendBridgePage"));
const BuildingPage = lazy(() => import("./pages/BuildingPage"));
const DojoGalleryPage = lazy(() => import("./pages/DojoGalleryPage"));
const BinComparePage = lazy(() => import("./pages/BinComparePage"));
const VaseComparePage = lazy(() => import("./pages/VaseComparePage"));
const CrayonComparePage = lazy(() => import("./pages/CrayonComparePage"));
const TypewriterPage = lazy(() => import("./pages/TypewriterPage"));
const ChromeAssetsPage = lazy(() => import("./pages/ChromeAssetsPage"));
const SurfacePaintPage = lazy(() => import("./pages/SurfacePaintPage"));
const MaterialXLabPage = lazy(() => import("./pages/MaterialXLabPage"));

// Old entry points (pre-router .html files, renamed routes, the three
// painting tools now unified under /paint, and retired single-asset viewers
// consolidated into the gallery / asset library) → current routes. Incoming
// query params are preserved; params baked into the target act as defaults.
const LEGACY_ROUTES: Record<string, string> = {
  "/blendbridge": "/",
  "/gnvm": "/bin",
  "/dojo": "/gallery?model=dojo-bin",
  "/periodic-brush": "/chrome-assets?asset=periodic-brush",
  "/vegetation-generator": "/paint?mode=ivy",
  "/geometry-painter": "/paint?mode=crystals",
  "/surface-draw": "/paint?engine=blender",
  "/blend-import.html": "/",
  "/building.html": "/building",
  "/dojo-viewer.html": "/gallery?model=dojo-bin",
  "/dojo-gallery.html": "/gallery",
  "/bin-studio.html": "/bin",
  "/bin/live": "/bin",
  "/bin-live.html": "/bin",
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
  return (
    // Route components now survive query-only changes. Runtime hooks own the
    // precise search-param restart boundary, so React state, focus, and shell
    // chrome do not reset just because a preset changed.
    <Routes>
          <Route path="/" element={<BlendBridgePage />} />
          <Route path="/building" element={<BuildingPage />} />
          <Route path="/gallery" element={<DojoGalleryPage />} />
          <Route path="/bin" element={<BinComparePage />} />
          <Route path="/vase" element={<VaseComparePage />} />
          <Route path="/crayon" element={<CrayonComparePage />} />
          <Route path="/typewriter" element={<TypewriterPage />} />
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
      {/* The provider renders .st-shell: a two-row grid of nav + route body.
          Both live inside it, so the nav is a grid row rather than a fixed bar
          floating over the tools. */}
      <StudioChromeProvider>
        {/* Outside the keyed Routes: the nav bar survives every navigation. */}
        <StudioNav />
        <Suspense fallback={<div className="route-loading">Loading procedural tool…</div>}>
          <StudioRoutes />
        </Suspense>
      </StudioChromeProvider>
    </BrowserRouter>
  );
}
