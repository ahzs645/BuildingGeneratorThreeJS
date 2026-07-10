import { defineConfig } from "vite";
import { blendImportPlugin } from "./tools/vite-blend-import";

// Multi-page app: each HTML file is a build entry so `vite build` emits them all.
export default defineConfig({
  plugins: [blendImportPlugin()],
  // Manifold WASM for GeometryNodeMeshBoolean in the live GN-VM viewer.
  optimizeDeps: {
    exclude: ["manifold-3d"],
  },
  assetsInclude: ["**/*.wasm"],
  build: {
    rollupOptions: {
      input: {
        main: "index.html", // landing / studio home
        building: "building.html", // Hong Kong building (hand-ported)
        dojo: "dojo-viewer.html", // baked bin (GLB)
        dojogallery: "dojo-gallery.html", // selectable Node Dojo Blender bakes
        binstudio: "bin-studio.html", // interactive baked-bin variants
        binlive: "bin-live.html", // live Blender-backed bin (full params)
        gnvm: "gnvm-viewer.html", // live geometry-nodes VM
        vase: "vase-compare.html", // Blender truth vs VM overlay
        blendimport: "blend-import.html", // drop a .blend and inspect/run its node graph
      },
    },
  },
});
