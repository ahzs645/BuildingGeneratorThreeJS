import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { appHref } from "../base-url";
import "./shell.css";

const HomePage = lazy(() => import("./pages/HomePage"));
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
const SurfaceDrawPage = lazy(() => import("./pages/SurfaceDrawPage"));
const MaterialXLabPage = lazy(() => import("./pages/MaterialXLabPage"));
const GeometryPainterPage = lazy(() => import("./pages/GeometryPainterPage"));
const VegetationGeneratorPage = lazy(() => import("./pages/VegetationGeneratorPage"));

function LegacyRedirect({ to }: { to: string }): React.JSX.Element {
  const { search } = useLocation();
  return <Navigate replace to={`${to}${search}`} />;
}

function NotFound(): React.JSX.Element {
  return <main className="not-found"><div><h1>That studio route does not exist.</h1><p><a href={appHref()}>Return to Procedural Studio</a></p></div></main>;
}

export default function App(): React.JSX.Element {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Suspense fallback={<div className="route-loading">Loading procedural tool…</div>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/blendbridge" element={<BlendBridgePage />} />
          <Route path="/building" element={<BuildingPage />} />
          <Route path="/dojo" element={<DojoViewerPage />} />
          <Route path="/gallery" element={<DojoGalleryPage />} />
          <Route path="/bin" element={<BinComparePage />} />
          <Route path="/bin/live" element={<BinLivePage />} />
          <Route path="/gnvm" element={<LegacyRedirect to="/bin" />} />
          <Route path="/vase" element={<VaseComparePage />} />
          <Route path="/crayon" element={<CrayonComparePage />} />
          <Route path="/typewriter" element={<TypewriterPage />} />
          <Route path="/periodic-brush" element={<PeriodicBrushPage />} />
          <Route path="/chrome-assets" element={<ChromeAssetsPage />} />
          <Route path="/surface-draw" element={<SurfaceDrawPage />} />
          <Route path="/materialx" element={<MaterialXLabPage />} />
          <Route path="/geometry-painter" element={<GeometryPainterPage />} />
          <Route path="/vegetation-generator" element={<VegetationGeneratorPage />} />

          <Route path="/blend-import.html" element={<LegacyRedirect to="/blendbridge" />} />
          <Route path="/building.html" element={<LegacyRedirect to="/building" />} />
          <Route path="/dojo-viewer.html" element={<LegacyRedirect to="/dojo" />} />
          <Route path="/dojo-gallery.html" element={<LegacyRedirect to="/gallery" />} />
          <Route path="/bin-studio.html" element={<LegacyRedirect to="/bin" />} />
          <Route path="/bin-live.html" element={<LegacyRedirect to="/bin/live" />} />
          <Route path="/gnvm-viewer.html" element={<LegacyRedirect to="/bin" />} />
          <Route path="/vase-compare.html" element={<LegacyRedirect to="/vase" />} />
          <Route path="/geometry-painter.html" element={<LegacyRedirect to="/geometry-painter" />} />
          <Route path="/vegetation-generator.html" element={<LegacyRedirect to="/vegetation-generator" />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
