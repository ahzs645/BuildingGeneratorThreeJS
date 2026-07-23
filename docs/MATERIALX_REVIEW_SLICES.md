# MaterialX review slices

The original research branch was intentionally kept separate while `main` had active geometry work. Its historical commits are useful provenance but are cross-cutting rather than clean cherry-picks. The reviewable integration was therefore reconstructed from current `main` in the dependency order below, with each stated gate rerun at its checkpoint.

No slice changes `src/chrome-assets.ts`, the Node Dojo material adapters, or GNVM geometry/node semantics. `/materialx` remains experimental and production dispatch remains unchanged.

## Slice 1: backend contract and capability preflight

Integrated checkpoint: `78642dd`.

Purpose: land the non-breaking policy and graph audit without a renderer or asset payload.

Primary historical commit: `6674a15` (contract/preflight portions). Later validation work appears in `dc05b42` and the current checkpoint.

Files:

- `src/material-backend.ts`
- `src/materials/material-backend.test.ts`
- `src/materialx/capabilities.ts`
- `src/materials/materialx-capabilities.test.ts`

Review focus:

- total fallback order is `materialx -> baked-pbr -> legacy-authored -> normalized`;
- unknown MaterialX elements fail preflight instead of silently becoming zero; and
- no production caller requests the new backend.

Gate: focused backend/capability tests, then the full test suite.

## Slice 2: isolated lab, adapter, and extraction tooling

Integrated checkpoint: `787795a`.

Purpose: land the route-owned renderer experiment and reproducible authoring tools without asking reviewers to validate generated shader bodies.

Primary historical commits: `6674a15`, `3e28998`, `4390ed8`, `e9514f5`, `58a3b46`, and `dc05b42`, plus the current UI normal-band checkpoint. Research-only commits `e854601` and `dddcde4` explain design choices but are not runtime dependencies.

Files:

- `src/react/App.tsx`
- `src/react/pages/HomePage.tsx`
- `src/react/pages/MaterialXLabPage.tsx`
- `src/react/pages/materialx-lab.css`
- `src/materialx-lab.ts`
- `src/materialx/essl-adapter.ts`
- `src/materialx/probe-geometry.ts`
- `src/materialx/procedural-height.ts`
- `tools/materialx/*.mjs`
- `tools/materialx/*.py`
- `tools/materialx/bake/**`
- MaterialX-related scripts in `package.json`
- the existing MaterialX-only Vite alias in `vite.config.ts`

The topology-discovered UI normal-band builder belongs here. It lowers Blender Mapping rotation to the official ESSL `rotate3d` convention generally and never checks a material name.

Gate: focused adapter/asset tests, headless WebGL compile/link smoke, full tests, and production build.

## Slice 3: portable inputs, generated outputs, evidence, and docs

Integrated as the evidence checkpoint immediately following Slice 2.

Purpose: land the auditable graph inputs, licenses, reproducible outputs, and parity evidence after the code that consumes them.

Primary historical commits: `3e28998`, `f657fc5`, `4390ed8`, `e854601`, `dddcde4`, `e9514f5`, `58a3b46`, `d05b042`, and `dc05b42`, plus the current UI normal-band checkpoint.

Files:

- `public/materialx/*.mtlx`
- `public/materialx/*.json`
- `public/materialx/baked/**`
- `public/materialx/generated/**`
- `public/materialx/licenses/**`
- `public/materialx/references/**`
- `docs/materialx-evidence/**`
- `docs/MATERIALX_DEPENDENCIES.md`
- `docs/MATERIALX_SHADER_PARITY.md`
- `docs/MATERIALX_NEXT_STEPS.md`
- this review-slice document
- `src/materials/materialx-assets.test.ts`
- `src/materials/materialx-essl.test.ts`

The approximately 80–103 KB fragment shaders are generated artifacts and should not be hand-reviewed line by line. Review their `.mtlx` inputs, generator tool/version pin, manifests, compile/link smoke result, and license headers. Regenerate with:

```bash
npm run materialx:generate:essl
npm run materialx:generate:ui-normal-band
npm run materialx:smoke:essl
```

Blender 5.1.2's bundled MaterialX 1.39.4 generator is pinned in each manifest. The official MaterialX Apache-2.0 license and third-party notices are committed under `public/materialx/licenses`; Blender is an external GPL authoring/comparison tool and no Blender code is vendored.

Runtime assets contain only graph/runtime dependencies. Historical captures live under `docs/materialx-evidence/archive`, authoritative comparisons under `docs/materialx-evidence/current`, and generated temporary render directories are not committed.

Gate: asset/evidence tests, regeneration diff review, headless compile/link smoke, full tests, and production build.

## Promotion boundary

These slices make the lab mergeable; they do not promote a production material. `chrome.003` remains gated until its native capability report contains no substituted semantics. The UI normal-band result is only a matched branch diagnostic while world-normal and color-to-Surface substitutions remain. Production keeps its authored materials and current renderer infrastructure throughout.
