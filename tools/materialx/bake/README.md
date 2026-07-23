# Chrome Crayon baked-PBR probe

This experiment bakes the synthetic Noise/Bump compatibility probe from
`render_blender_references.py`; it is not presented as a node found in the
supplied `chrome.003` material. The source graph is object Position × 4 →
Blender Noise Texture (3D) → Bump (strength 0.18, distance 0.1).

Run the bake from the repository root:

```sh
node tools/materialx/run_blender.mjs 'Chrome Crayon Surface Draw Test.blend' \
  tools/materialx/bake_chrome_probe.py -- \
  --asset-dir public/materialx/baked \
  --reference-dir docs/materialx-evidence/baked
```

Run the isolated Three/MaterialX validation capture:

```sh
npm exec vite -- --host 127.0.0.1 --port 4174 --force
node tools/materialx/bake/capture.mjs http://127.0.0.1:4174 \
  docs/materialx-evidence/baked/noise-bump-baked-web.png \
  'backend=materialx'
```

Then compute Blender-to-Blender semantic evidence and Blender-to-Three
renderer evidence:

```sh
node tools/materialx/run_blender.mjs 'Chrome Crayon Surface Draw Test.blend' \
  tools/materialx/bake/compare.py -- docs/materialx-evidence/baked
```

Texture contract:

- `chrome-crayon-noise-normal.png`: tangent-space normal, 8-bit PNG,
  Non-Color/raw, OpenGL/MaterialX normal convention.
- `chrome-crayon-roughness.png`: scalar roughness in grayscale RGB, 8-bit PNG,
  Non-Color/raw. The probe's authored value is 0.32.
- UVs are an equirectangular unwrap of the 64 × 32 comparison sphere. A
  production object needs its own non-overlapping bake UV set; the maps are
  not object-independent procedural textures.

The `.mtlx` is validated with Blender 5.1's bundled MaterialX library and is
also loaded for the web capture through Three 0.185.1 `MaterialXLoader`, not a
hand-authored Three material.

## Provenance and licensing

All scripts in this directory and `bake_chrome_probe.py` are original project
code. They invoke Blender 5.1's built-in Cycles baker; no third-party Blender
add-on or exporter code is copied or invoked. Blender is GPL-2.0-or-later and
is used as an external authoring tool. Its license does not add Blender source
code to these generated PNG/MaterialX assets. The maps are derived solely from
the supplied project `.blend`. Three.js and MaterialX retain their existing
upstream licenses; neither is vendored by this experiment.

The authoritative hashes, Blender version, parameters, validation result, and
semantic metrics are in `docs/materialx-evidence/baked/bake-report.json`.
Cross-renderer metrics are in `web-comparison.json` beside it.
