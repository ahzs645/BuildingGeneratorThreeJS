# MaterialX parity checkpoint and next steps

## Checkpoint summary

The isolated MaterialX lab is technically viable. Native extraction now reconstructs Blender Generated coordinates as object position normalized by per-object bounds, with a zero-extent guard. It also restores `rough` as `geompropvalue` from an exact external geometry contract: the topology-exact 2.5D Chrome Crayon evidence identifies a FACE-domain float that is flat-expanded into the browser vertex buffer. The native `chrome.003` extraction report is free of substituted semantics, its official ESSL compiles and links, and the shader is bound to the live 97,784-vertex / 97,776-face GN-VM asset as an opt-in preview.

The matched capture closes the implementation checkpoint without claiming renderer identity. Full-frame RMSE is `0.057457` with luminance correlation `0.681123`. The object is a zero-roughness metal, and Eevee versus MaterialX FIS reflection highlights remain substantially different inside the visible surface. The authored shader therefore remains the default.

The direct-light direction problem is closed. It was not a Blender/Three basis mismatch: the matched UV sphere was wound inward. Eevee rendered the two-sided backfaces, while Three's default `FrontSide` path culled the near hemisphere and shaded the far hemisphere. Both probe generators now use outward winding, and a topology test checks every probe triangle.

Direct lights now follow one explicit contract:

1. Blender writes evaluated camera and Sun `matrix_world` values to `public/materialx/references/scene-contract.json`.
2. Evaluated Sun local `-Z` is stored as the world-space propagation direction.
3. The ESSL adapter uploads that vector unchanged as `LightData.direction`.
4. MaterialX `ND_directional_light` negates it to produce the surface-to-light vector used by the BSDF.
5. The `+90°` MaterialX transform remains environment-only; there is no fitted direct-light transform.

## Current evidence

| Check | Sphere RMSE | Sphere luminance correlation | Status |
| --- | ---: | ---: | --- |
| key light, environment disabled | 0.068691 | 0.991038 | direction passes |
| fill light, environment disabled | 0.029614 | 0.988250 | direction passes |
| rim light, environment disabled | 0.038945 | 0.975296 | direction passes |
| canonical Noise bump | 0.146605 | 0.804343 | useful parity prototype |
| UI normal-band branch | 0.012820 | 0.992491 | typed `col` passes; two substitutions remain |
| native source lowering sphere | 0.440571 | 0.104222 | historical substituted capture; superseded by the recovered live 2.5D comparison |

The recovered live 2.5D result is measured separately because it uses an orthographic asset frame rather than the sphere mask: full-frame RMSE `0.057457`, full-frame correlation `0.681123`, and visible-region IoU `0.926767`. The visible-region threshold is reflection-dependent and is not a geometry silhouette claim; topology and bounds are validated independently.

The Noise bump full-frame result is RMSE `0.055410` with correlation `0.935745`. Its Blender/browser sphere mean luminance is `0.449082` versus `0.457048`. Highlight width and fine noise remain different because Eevee, MaterialX FIS, and the two noise implementations are not identical.

The UI result is a branch diagnostic, not a source-material parity claim. Its matched identity-transform fixture neutralizes an official-ESSL world/object normal-space discrepancy, and an emission wrapper substitutes Blender's implicit color-to-Surface coercion. The supplied metadata has no corresponding source `.blend`, so native extraction cannot yet be audited.

The source-lowering sphere image must not be improved with material-name-specific roughness, color, coordinate, or light tweaks. Its poor result is historical evidence from before native recovery and remains labeled as such. The recovered native graph is measured in the separate live 2.5D comparison.

## Prioritized work

### 1. Carry implemented Generated semantics through native extraction — complete

The isolated ESSL adapter already:

- exports evaluated object bounds in the scene contract;
- lowers Generated coordinates to `(positionObject - boundsMin) / max(boundsMax - boundsMin, epsilon)`;
- binds the generated bounds uniforms from the manifest; and
- tests the normalized coordinate contract independently of material names.

The native extractor now recognizes Blender's Generated `texcoord`/`convert` surrogate and replaces it with the same general object-position, bounds-offset, safe-extent, and divide graph. The regenerated `chrome-crayon-native.report.json` no longer records a `generated-coordinate` substitution. The interface remains per object, so translation, rotation, and non-uniform scale do not become baked material constants; the explicit epsilon `max` defines zero-extent behavior. Image similarity remains secondary to this semantic proof.

### 2. Carry implemented typed geometry properties through native extraction — complete for `rough`

The isolated manifest-driven adapter already records and binds required point properties by exported name and type, rejects incompatible buffer item sizes, and exercises both `rough:float` and `col:color3`. The UI normal-band diagnostic proves the `col` path without selecting a material name.

The extractor now accepts an exact external geometry contract and validates the named Attribute node, source socket, target node, and target socket against Blender before emitting `geompropvalue`. For `chrome.003`, the contract cites the topology-exact 2.5D Chrome Crayon dump/status, records FACE-domain source data, flat-expanded vertex binding, and the authored `[0, 0]` range.

Remaining broader extraction work is to:

- add equally explicit contracts for other materials instead of inferring domains;
- define conversion for mixed/nonconstant corner, face, and constant data beyond the implemented point/vertex GPU bindings; and
- route missing required production data to `baked-pbr`, then `legacy-authored`, instead of silently rendering zero.

`chrome.003` now passes native extraction semantics on the official ESSL path. Three TSL still rejects `geompropvalue`. Procedural Mahogany remains blocked on Wave and its separate named properties.

### 3. Re-run native `chrome.003` semantic parity — complete

Steps 1 and 2 now carry through the full live path:

- native extraction is regenerated from the exact asset-library `.blend`;
- official MaterialX 1.39.4 ESSL generation exposes both Generated bounds and `rough`;
- the live 2.5D GN-VM mesh supplies validated object bounds, normals, fallback tangents, and one `rough=0` value per GPU vertex; and
- matched Blender/browser captures and machine-readable metrics are committed.

The capability audit has no unsupported or substituted source semantics, and no required attribute uses its default. Default-material promotion remains withheld because the measured zero-roughness reflection response is still renderer-dependent. A visually similar image alone is not sufficient.

### 4. Replace per-fragment FIS with the official prefilter path

Exercise MaterialX's Apache-2.0 environment prefilter shader inside the isolated lab:

- generate the GGX radiance mip chain once per environment;
- retain the separate irradiance binding;
- compare environment-only smooth-metal renders at roughness `0`, `2/15`, and
  `0.2610441`, covering `chrome.003`, `chrome.002`, and the Chrome Grill;
- measure startup cost, memory, and captured-image changes; and
- keep FIS as the reference fallback until the prefilter path passes.

Do not copy Blender's GPL Eevee convolution shader. Blender remains external comparison evidence only.

This is a shared renderer problem rather than a per-material color problem.
Chain and Mace, Chrome Grill, and Text Soup already have aligned silhouettes
(`0.9626–0.9750` IoU), but their polished-metal spatial correlations remain
`0.227`, `0.493`, and `0.018`. Chrome Grill's mean luminance is already within
`-0.00169`, so a monotonic color transform cannot recover the misplaced
highlight structure. Environment-disabled MaterialX direct-light probes reach
`0.975–0.991` correlation, while supplying Blender's exact studio EXR improves
but does not close the chrome assets. The new path must therefore reuse one
authoritative linear HDR source and one cached GGX-prefiltered representation
across all three roughness checkpoints, with the current FIS and Three PMREM
paths retained as measured fallbacks.

### 5. Calibrate direct-light energy without moving lights

The direction diagnostic is now frozen. Remaining direct-light work may adjust only a topology-independent Blender-Sun-to-MaterialX intensity conversion, supported by the three smooth-metal renders and preferably a diffuse control. Do not rotate lights or tune individual material parameters to compensate for BRDF differences.

### 6. Exercise representative follow-on materials

Use this order:

1. UI normal band is now exercised as a topology-discovered branch diagnostic. Keep it parity-gated until world-normal handling, color-to-Surface semantics, and native source extraction are resolved.
2. Procedural Mahogany follows after named-attribute extraction and a general Wave lowering or documented bake exist.
3. Toon remains last; ShaderToRGB is renderer-dependent and should remain `legacy-authored` or baked unless a portable semantic contract is defined.

Each material gets its own capability report and matched evidence, but all mappings must be selected by node type and graph topology rather than datablock name.

### 7. Converge the optional TSL path

Give the isolated `MaterialXLoader`/`WebGPURenderer` experiment the same scene-contract, attribute-manifest, and diagnostic inputs as the official ESSL reference. Re-evaluate Three PR #33485 or its merged successor at a pinned revision. Do not migrate production pages or custom `ShaderMaterial` post-processing until a node-renderer-owned viewport passes the same evidence gates.

### 8. Production promotion gate

Promote one material from `legacy-authored` only when all of the following are true:

- extraction is reproducible and all texture/property dependencies are declared;
- capability preflight has no unsupported or silently substituted source semantics;
- graph diagnostics pass independently of the beauty render;
- Blender/browser evidence is reviewed under the frozen scene contract;
- missing data and unsupported renderers still select the existing authored fallback;
- the production geometry supplies every shader-declared position, normal, tangent/UV when requested, and named attribute;
- focused tests, the full test suite, and the production build pass; and
- the change remains scoped to a renderer-owned viewport—no global renderer migration.

## Reproducible checkpoint commands

```bash
npm run materialx:extract
npm run materialx:generate:essl
npm run materialx:generate:native
npm run materialx:generate:ui-normal-band
npm run materialx:smoke:essl
npm run materialx:render:blender
npm run materialx:render:25d
npm run dev -- --host 127.0.0.1 --port 4173
npm run materialx:capture:web
npm run materialx:capture:25d
npm run materialx:compare
npm run materialx:compare:25d
npm test
npm run build
```

The capture commands expect the development server to remain running. Runtime resources stay in `public/materialx/references`; probe metrics are in `comparison.json` and live-asset metrics are in `25d-native-comparison.json`. Graph support remains independently recorded in extraction reports and generated manifests. Native graph and live binding parity now pass; keep authored `chrome.003` as the default until the Eevee/FIS reflection residual is accepted or reduced under a renderer-specific promotion policy.

## Explicitly deferred

- Global replacement of `WebGLRenderer`.
- Rewriting existing production `ShaderMaterial` or post-processing infrastructure.
- Material-name-specific graph rewrites or light transforms.
- Copying GPL, noncommercial, or unlicensed shader implementations.
- Inventing missing logos, stickers, fonts, or texture assets.
- Treating pixel correlation as proof of graph-semantic support.
