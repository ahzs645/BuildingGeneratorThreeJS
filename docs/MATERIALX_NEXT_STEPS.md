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
5. The environment-only transform follows the projection formulas rather than
   a fitted angle: Blender Z-up `(x,y,z)` maps to MaterialX Y-up
   `(-y,-z,-x)`. Direct lights remain in Blender world space.

## Current evidence

| Check | Sphere RMSE | Sphere luminance correlation | Status |
| --- | ---: | ---: | --- |
| key light, environment disabled | 0.068691 | 0.991038 | direction passes |
| fill light, environment disabled | 0.029614 | 0.988250 | direction passes |
| rim light, environment disabled | 0.038945 | 0.975296 | direction passes |
| canonical Noise bump | 0.072938 | 0.959128 | useful parity prototype |
| UI normal-band branch | 0.012820 | 0.992491 | typed `col` passes; two substitutions remain |
| five physical-conductor presets | 0.024220–0.029240 | 0.977153–0.981634 | constant n/k inputs pass |
| Gold F82 artistic tint | 0.026614 | 0.979207 | `color0/color82` mapping passes |
| Gold layered roughness | 0.015789 | 0.994633 | four-closure scales and sequential mixes pass |
| Gold roughness Fresnel | 0.024804 | 0.984648 | Layer Weight/RGB Curve/B-spline response passes |
| Gold procedural brushed roughness | 0.032220 | 0.961876 | normalized Blender FBM adapter passes |
| Gold anisotropy, 0 / 0.25-turn | 0.119664 / 0.083424 | 0.893565 / 0.945596 | Cycles tangent directions pass |
| Gold thin film, 0 / 243 nm | 0.009443 / 0.061831 | 0.999186 / 0.998885 | exact inputs pass; 243 nm hue residual recorded |
| Gold activated thin-film streak | 0.066369 | 0.964480 | diagnostic override passes; active source remains 0 nm |
| active Gold non-image core | 0.020777 | 0.993585 | Physical Conductor composition passes; two scratch maps omitted |
| native source lowering sphere | 0.440571 | 0.104222 | historical substituted capture; superseded by the recovered live 2.5D comparison |

The recovered live 2.5D result is measured separately because it uses an orthographic asset frame rather than the sphere mask: full-frame RMSE `0.057457`, full-frame correlation `0.681123`, and visible-region IoU `0.926767`. The visible-region threshold is reflection-dependent and is not a geometry silhouette claim; topology and bounds are validated independently.

The Noise bump full-frame result is RMSE `0.028039` with correlation `0.984012`.
Its Blender/browser sphere mean luminance is `0.449082` versus `0.467206`.
Highlight width and fine noise remain different because Eevee, MaterialX FIS,
and the two noise implementations are not identical.

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

### 4. Replace per-fragment FIS with the official prefilter path — matched roughness sweep complete

The isolated lab now exercises MaterialX's Apache-2.0 environment prefilter
shader directly:

- `generate_essl.py` emits both PREFILTER material shaders and the official
  1,024-sample environment-writer pass;
- one documented ESSL compatibility rewrite changes MaterialX 1.39.4's invalid
  `pow(float, int)` overload to the equivalent
  `exp2(float(u_envPrefilterMip))`;
- the browser renders and validates all nine float radiance levels from
  `256×128` through `1×1`, retaining the separate irradiance binding;
- isolated SwiftShader runs take approximately `0.7–3.1 s` across warm and
  cold captures, with finite, non-empty radiance at every level;
- the live topology-exact 2.5D asset exposes PREFILTER as an opt-in preview
  while FIS remains available; and
- a matched Blender/browser capture and comparison are stored separately from
  the prior FIS evidence.

The lab now exposes an environment-only smooth-conductor diagnostic and binds
roughness through the generated public-uniform interface. It does not select a
material or Blender node-group display name. Blender and the browser render the
same outward-wound sphere, camera, linear studio EXR, Standard/sRGB transform,
and `0.18` environment intensity with direct lights and floor disabled.

The sweep also found and closed the dominant orientation error. Blender's
Environment Texture projects `(-atan(y,x), +asin(z))`, while MaterialX projects
`(+atan(x,-z), -asin(y))`. The exact environment basis is therefore
`(x,y,z) -> (-y,-z,-x)`, not the previous longitude-only `+90°` rotation.

| Roughness | Backend | Sphere RMSE | Sphere luminance correlation | Mean luminance Blender / web |
| ---: | --- | ---: | ---: | ---: |
| `0` | FIS | 0.020569 | 0.991816 | 0.274795 / 0.278934 |
| `0` | PREFILTER | 0.020553 | 0.991828 | 0.274795 / 0.278935 |
| `2/15` | FIS | 0.020306 | 0.992846 | 0.276793 / 0.285034 |
| `2/15` | PREFILTER | 0.017830 | 0.993967 | 0.276793 / 0.283546 |
| `0.2610441` | FIS | 0.037781 | 0.978904 | 0.282336 / 0.294164 |
| `0.2610441` | PREFILTER | 0.026480 | 0.988384 | 0.282336 / 0.295910 |

At roughness zero both implementations sample level zero and correctly remain
nearly identical. PREFILTER improves the two nonzero checkpoints, with the
largest gain at Chrome Grill's `0.2610441`. This establishes the shared
environment backend; it does not by itself prove parity for every asset's
complete authored shader.

The same PREFILTER path now validates a rights-safe five-metal matrix derived
from `Metallic_BSDF+.blend`: Aluminum, Copper, Gold, Stainless Steel, and
Titanium. The source contributes only independently extracted n/k constants and
remains outside the repository. A critical cross-runtime rule is now explicit
and tested: MaterialX conductor roughness is microfacet alpha, so Blender's
perceptual roughness must be squared (`0.35 → 0.1225`). With that conversion,
all five sphere-region correlations exceed `0.977` and RMSE remains below
`0.030`. This closes the constant-input `PHYSICAL_CONDUCTOR` gate, not the
complete add-on graph or its scratch and thin-film branches.

The companion Gold F82 probe now closes the constant artistic-tint gate.
Blender Base Color and Edge Tint map directly to MaterialX generalized Schlick
`color0` and `color82`, with white `color90`, exponent `5`, and the same squared
roughness conversion. The matched sphere reaches RMSE `0.026614` and
correlation `0.979207`.

The layered-roughness, view-dependent roughness-Fresnel, and active procedural
brushed-roughness gates are now complete independently. Their matched beauty
spheres reach correlations `0.994633`, `0.984648`, and `0.961876`
respectively. The marked brushed graph uses a clean-room normalized Blender
FBM ESSL adapter rather than claiming that native MaterialX `fractal3d` has
Blender Noise Texture semantics.

The constant anisotropy/tangent gate is also complete for Cycles. The browser
uses Blender's exact aspect conversion (`alphaX=alpha/aspect`,
`alphaY=alpha*aspect`) and rotates `Tworld` by `rotation*360°`. Key-light-only
captures prove both the horizontal and quarter-turn vertical lobes. Sphere
correlations are `0.893565` and `0.945596`; mean luminance differs by less than
`0.005` in both. Isotropic PREFILTER is not valid evidence for this branch
because it reduces the two axes to their geometric mean. Production
anisotropic materials must keep direct/FIS evaluation or use a future
anisotropic environment filter.

The uniform anodization gate is now complete as well. The supplied Gold group
maps its voltage socket to nanometers as `voltage * 1.62` and uses a thin-film
IOR of `2.46`. A 150 V checkpoint therefore compares Blender and MaterialX at
exactly `243 nm`. Its Cycles/direct-light sphere reaches RGB RMSE `0.061831`
and luminance correlation `0.998885`.

A zero-thickness control reaches RMSE `0.009443` and correlation `0.999186`, so
the 243 nm residual is isolated to interference rather than base F82 or light
direction. Matching inputs preserve the highlight structure and luminance, but
not the exact interference hue: mean sphere blue is `0.209001` in Blender and
`0.124979` in MaterialX. A measured web sweep can fit this one view with a
different thickness, but that would break the source's nanometer contract and
is not used. The evidence records the spectral-approximation difference
explicitly.

The procedural discoloration branch has also been traced. In the supplied
`Material.011`, Gold `Socket_27` is unlinked at `(0,0,0)`: raw FBM evaluates to
zero, its B-spline ramp is black, voltage is zero, and the active result is
exactly `0 nm`. A separate diagnostic explicitly binds that socket to Generated
coordinates and validates the intended normalized/raw Blender FBM, ramp, and
`0..1390 nm` mapping. It reaches sphere correlation `0.964480`, but remains
labeled as an activated diagnostic—not active-source parity.

The active rights-safe Gold composition is now validated in one
PHYSICAL_CONDUCTOR graph. It combines roughness `0.4499999583`, Roughness
Fresnel `0.1`, Generated-coordinate brush factor `0.2730000019`, Layered
Roughness `1`, Gold n/k, anisotropy `0`, and thin film `0 nm`. With only the
two scratch inputs forced to zero, the beauty sphere reaches RMSE `0.020777`
and correlation `0.993585`.

Those scratch inputs are the remaining exact saved-appearance blocker. Both
are active packed `4096×4096` sRGB maps, with dense factor `0.5334029198` and
sparse factor `1`. No standalone redistribution license accompanies their
bytes, so the repository records their hashes and dependency contracts without
shipping the pixels or a reversible bake.

Remaining work for this item is to:

- add matched evidence for the remaining catalog registrations and continue
  applying the loader beyond the current six assets and topology-exact 2.5D
  asset;
- record hardware startup cost and the radiance-chain memory footprint; and
- retain FIS as a measured fallback while production promotion remains opt-in.

The first catalog rollout is now modular rather than another asset-specific
`MeshPhysicalMaterial`. `catalog-metal-surfaces.mtlx` registers three reusable
rights-safe shader contracts across six catalog assets:

- Chrome Grill's constant Principled metal (`0.2508697` linear base,
  Metallic `1`, Roughness `0.2610441`);
- Chain and Mace's vertex-bound `rough / 15` perceptual roughness; and
- Text Soup's Blender-compatible missing-`rough` resolution to zero.

Chrome Grill, Chain and Mace, Soft Pixel Marker, Type Pixel Brush, Blunt Metal
Marker, and Text Soup run through one live catalog loader, the exact
Blender-to-MaterialX environment basis, the bundled CC0 `studio.exr`, and the
official 1,024-sample GGX prefilter. Their authored Three.js modes remain the
defaults.

The three distinct evidence checkpoints currently have matched Blender/web
captures. They preserve exact topology at `61,812 / 53,892` (Chrome Grill),
`120,727 / 214,718` (Chain and Mace), and `11,971 / 11,199` (Text Soup).
Full-frame luminance correlations
are `0.571404`, `0.655573`, and `0.596573`, respectively. Chrome Grill's
foreground correlation is only `0.216802`; the other two reach `0.382174` and
`0.523057`. These are useful measured results, not renderer-identity claims:
the MaterialX path carries portable shader semantics and a correct environment
contract, but it is not promoted merely because its highlights look plausible.

The rollout also closed two general adapter gaps exposed by standard-surface
graphs: active `surfaceshader`/`displacementshader` struct uniforms now receive
typed defaults, and fixed-size ESSL light arrays are padded with inactive
records when a material intentionally uses zero direct lights.

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
npm run materialx:generate:essl-prefilter
npm run materialx:generate:native
npm run materialx:generate:prefilter
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
