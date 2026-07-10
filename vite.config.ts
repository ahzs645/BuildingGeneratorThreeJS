import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { blendImportPlugin } from "./tools/vite-blend-import";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react(), blendImportPlugin()],
  // Manifold WASM for GeometryNodeMeshBoolean in the live GN-VM viewer.
  optimizeDeps: {
    exclude: ["manifold-3d"],
  },
  assetsInclude: ["**/*.wasm"],
});
