import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { blendImportPlugin } from "./tools/vite-blend-import";
import fs from "node:fs";
import path from "node:path";

const upstreamThreeRoot = process.env.MATERIALX_THREE_ROOT
  ? path.resolve(process.env.MATERIALX_THREE_ROOT)
  : null;

if (upstreamThreeRoot && !fs.existsSync(path.join(upstreamThreeRoot, "src/Three.WebGPU.js"))) {
  throw new Error(`MATERIALX_THREE_ROOT is not a prepared Three.js package: ${upstreamThreeRoot}`);
}

const upstreamThreeAliases = upstreamThreeRoot
  ? [
      { find: /^three\/webgpu$/, replacement: path.join(upstreamThreeRoot, "src/Three.WebGPU.js") },
      { find: /^three\/tsl$/, replacement: path.join(upstreamThreeRoot, "src/Three.TSL.js") },
      { find: /^three\/addons\/(.*)$/, replacement: `${path.join(upstreamThreeRoot, "examples/jsm")}/$1` },
      { find: /^three\/examples\/jsm\/(.*)$/, replacement: `${path.join(upstreamThreeRoot, "examples/jsm")}/$1` },
      { find: /^three$/, replacement: path.join(upstreamThreeRoot, "src/Three.js") },
    ]
  : undefined;

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react(), blendImportPlugin()],
  resolve: upstreamThreeAliases ? { alias: upstreamThreeAliases } : undefined,
  // Manifold WASM for GeometryNodeMeshBoolean in the live GN-VM viewer.
  optimizeDeps: {
    exclude: ["manifold-3d"],
  },
  assetsInclude: ["**/*.wasm"],
});
