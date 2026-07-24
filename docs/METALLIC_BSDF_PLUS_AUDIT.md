# Metallic BSDF+ reference audit

Audit date: 2026-07-24

## Scope and provenance

This audit covers the user-supplied `Metallic_BSDF+.blend` reference without
copying the source binary or its complete shader graphs into the repository.
Its SHA-256 fingerprint is:

```text
608e5bae814fba45cfa5d6c6934aae54312128cb72ed940a5aa1a03dd10d8a7d
```

The file reports that it was written by Blender 5.2.31. It was inspected with
Blender 5.1.2, which warns that newer-file data may be lost. No redistribution
license was found beside the file or in its embedded overview, so the binary
and full extracted graph payload must remain outside version control unless a
license is recovered.

## What the file contributes

The file is a useful future shader-compatibility target:

- 33 materials;
- 36 shader node groups;
- 30 named metal and alloy presets in the current `Metallic BSDF+` selector;
- three implementation generations: `Metallic BSDF+ V1.0.0`, V1.1.0, and the
  current group;
- dedicated Blender `ShaderNodeBsdfMetallic` nodes using both `F82` artistic
  tint and `PHYSICAL_CONDUCTOR` Fresnel modes;
- base color, edge tint, roughness, layered roughness, roughness Fresnel,
  anisotropy, anisotropic rotation, tangent, and normal controls;
- brushed-metal texture controls, scratches/wear branches, and thin-film
  anodization controlled by voltage and IOR.

The repeated metal presets use the same broad 150–180-node structure with
different physical or artistic constants. This makes them a better regression
matrix than thirty unrelated one-off materials.

## What it tells the browser shader to expose

The file confirms that a useful Blender-compatible metal control cannot be
reduced to a single `metalness` checkbox. The portable control surface needs:

- a conductor mode with either physical IOR/extinction data or artistic
  base/edge tint (`F82`);
- scalar or layered roughness, including the view-dependent roughness-Fresnel
  branch;
- anisotropy, rotation, and an explicit tangent contract;
- normal input plus optional brushed/scratch texture layers;
- thin-film thickness and IOR for anodized finishes; and
- one shared, correctly oriented HDR environment response across every preset.

The current `/materialx` lab implements the last item and the direct-conductor
foundation. It does not yet expose the complete Blender group as editable web
controls, so a plausible shiny sphere must not be labeled as a recovered
Aluminum, Copper, Gold, Stainless Steel, or Titanium preset until its conductor
constants and reachable branches are extracted and validated.

## Current compatibility boundary

`tools/dump_blend.py` already preserves the materials and all 36 nested shader
node groups in `materials` and `shader_node_groups`. The browser material
runtime does not yet implement `ShaderNodeBsdfMetallic`, its Fresnel modes, or
generic nested shader-group evaluation.

The native MaterialX extractor now accepts both the existing OpenPBR root and
Blender's direct MaterialX surface/BSDF form. Running it against the active
Aluminum preset produces:

```text
surface
  mix (BSDF)
    mix (BSDF)
      mix (BSDF)
        conductor_bsdf
        conductor_bsdf
      conductor_bsdf
    conductor_bsdf
```

The real graph validates as MaterialX 1.39 and generates a 77,369-byte official
ESSL shader that compiles and links in WebGL2. The direct-conductor path is
capability-gated to official ESSL; Three.js's current MaterialX TSL loader still
rejects `surface` and `conductor_bsdf` explicitly.

This proves graph extraction and shader compilation, not browser render parity.
The active preset still has unresolved inputs:

- two packed scratch textures become sampler uniforms. The ESSL runtime now
  binds filename inputs through a schema-v2 bundle that verifies path, byte
  count, SHA-256, sampler state, upload color space, and disposal, but the real
  preset has not been packaged because its texture rights and complete
  extraction metadata are unresolved;
- the native USD records `srgb_texture`, while the standalone extractor does
  not yet propagate that color-space metadata;
- the reachable Layer Weight → RGB Curves → Color Ramp roughness-Fresnel branch
  is absent from the native MaterialX network;
- Blender Generated coordinates need a bounds-normalized geometry contract;
- the source was written by Blender 5.2.31 but the available extraction run
  used Blender 5.1.2;
- no redistribution license covers the source, packed images, or generated
  derivative shader bundle.

This reference does not directly explain the 3D Chrome Crayon Generator's
remaining `flat.nodes` residual. That material is attribute-driven emission,
not a metallic BSDF. It is nevertheless directly relevant to Chrome Asset
Library metals and future Blender 5.2 material imports.

## Modular implementation path

1. Add a versioned MaterialX bundle descriptor containing the portable graph,
   generated vertex/fragment shaders, uniform and texture bindings, geometry
   contract, source fingerprints, license state, and capability report.
2. Propagate image color space, dimensions, sampler state, byte size, and
   SHA-256 through extraction and shader generation. Reject missing, absolute,
   parent-relative, or unlicensed runtime assets.
3. Teach the ESSL adapter to bind and dispose texture uniforms. Keep this
   asynchronous lifecycle in the MaterialX lab first; the synchronous authored
   material registry must not hide loading behind `resolve()`.
4. Recover Blender RGB Curve semantics as a deterministic 1D LUT, including
   composite/R/G/B curves, handle behavior, clipping, and extension. Do not
   approximate the non-identity curve with a straight line.
5. Preserve explicit Generated-coordinate bounds plus UV/tangent requirements
   in the geometry contract.
6. Validate a small preset matrix before expanding to all thirty presets:
   Aluminum, Copper, Gold, Stainless Steel, and Titanium cover neutral,
   colored, brushed, and thin-film-relevant behavior.
7. Compare deterministic material probes rendered from identical geometry,
   camera, environment, and color-management settings. Keep geometry parity,
   shader-graph parity, and final raster similarity as separate claims.

Until redistribution permission is recovered, use the real file only as a local
oracle and commit a repository-authored synthetic conductor/texture fixture for
runtime tests.

The rights-safe runtime checkpoint is now present:

- `src/materials/fixtures/materialx-direct-conductor.mtlx` exercises a
  repository-authored layered direct conductor with a filename input;
- `src/materialx/essl-bundle.ts` loads only bundle-relative, integrity-checked
  textures and keeps authored source color space separate from WebGL upload
  decoding;
- `src/materials/materialx-essl-bundle.test.ts` covers capability gating,
  one-to-one sampler binding, path traversal, integrity failures, abort cleanup,
  and idempotent disposal.

The shared environment checkpoint is also complete:

- the MaterialX lab can select FIS or the official 1,024-sample GGX PREFILTER
  backend while binding exact roughness through the generated shader interface;
- Blender's Z-up Environment Texture basis is converted exactly to MaterialX's
  Y-up basis as `(x,y,z) -> (-y,-z,-x)`;
- matched environment-only sphere captures cover roughness `0`, `2/15`, and
  `0.2610441`; and
- PREFILTER reaches sphere luminance correlation `0.991828`, `0.993967`, and
  `0.988384` respectively. At `0.2610441`, sphere RMSE improves from FIS
  `0.037781` to PREFILTER `0.026480`.

This closes the shared studio-lighting prerequisite for the five-preset matrix.
It does not close `ShaderNodeBsdfMetallic`, RGB Curves, anisotropy, thin film,
or the rights status of the source textures.

The first rights-safe physical-conductor matrix is now complete. Blender builds
fresh `ShaderNodeBsdfMetallic` probes from the extracted n/k constants, while
the browser compiles five repository-authored `conductor_bsdf` surfaces through
official MaterialX ESSL. No source node graph, image, or source material is
included in the web fixture.

A semantic conversion was required: Blender exposes perceptual roughness, but
MaterialX `conductor_bsdf` consumes microfacet alpha. The matched probe therefore
maps Blender roughness `0.35` to MaterialX alpha `0.35² = 0.1225`. Passing
`0.35` directly over-blurred the web reflections and reduced sphere correlation
to `0.768–0.818`; the squared mapping restores the studio-light shapes:

| Preset | Sphere RMSE | Sphere luminance correlation | Mean luminance Blender / web |
| --- | ---: | ---: | ---: |
| Aluminum | 0.029240 | 0.978617 | 0.309113 / 0.317926 |
| Copper | 0.026639 | 0.980994 | 0.263398 / 0.274114 |
| Gold | 0.028653 | 0.980098 | 0.283675 / 0.294926 |
| Stainless Steel | 0.024428 | 0.981634 | 0.254473 / 0.263739 |
| Titanium | 0.024220 | 0.977153 | 0.200332 / 0.214242 |

The constant-input F82 gate is now complete as well. Blender's Metallic BSDF
maps directly to MaterialX `generalized_schlick_bsdf`:

- Blender Base Color → MaterialX `color0`;
- Blender Edge Tint (F82) → MaterialX `color82`;
- grazing color → white `color90`;
- exponent → `5`; and
- Blender perceptual roughness `0.35` → MaterialX alpha `0.1225`.

The Gold control point uses the exact linear values stored in source sockets
`Socket_887` and `Socket_888`. Its matched sphere reaches RMSE `0.026614`,
luminance correlation `0.979207`, and mean luminance `0.286450 / 0.295235`
for Blender/web. This validates constant-input F82 behavior without converting
the artistic controls to n/k values.

The source file remains the local oracle for the still-open layered roughness,
roughness-Fresnel, scratches, and thin-film gates.

The constant-input anisotropy/tangent gate is now complete for Cycles. Blender
maps perceptual roughness `r` and anisotropy `a` to the microfacet axes:

```text
alpha = r²
aspect = sqrt(1 - 0.9a)
alphaX = alpha / aspect
alphaY = alpha * aspect
tangentRotationDegrees = rotation * 360
```

At `r=0.35` and `a=0.8`, the exact MaterialX inputs are
`alphaX=0.23150323971815168` and `alphaY=0.06482090712108245`. Blender uses a
radial-Y tangent; the matched web sphere uses its UV-derived `Tworld` tangent,
which is the same azimuthal axis up to an irrelevant sign. Direct key-light
captures with the environment disabled prove both orientations:

| Rotation | Sphere RMSE | Sphere luminance correlation | Mean luminance Blender / web |
| ---: | ---: | ---: | ---: |
| `0` turns | 0.119664 | 0.893565 | 0.231747 / 0.226942 |
| `0.25` turns | 0.083424 | 0.945596 | 0.216373 / 0.216979 |

The isotropic GGX PREFILTER backend cannot validate this branch: it collapses
the two alphas to their geometric mean and therefore produces the same
environment response as the isotropic `0.1225` probe. Anisotropic assets must
retain direct/FIS evaluation or gain a dedicated anisotropic environment
filter; they must not silently use the isotropic mip chain as parity evidence.
Eevee 5.1 also rendered this native node isotropically in the diagnostic, so
the authoritative Blender anisotropy references use Cycles and say so in the
render contract.

The uniform thin-film gate is now traced from the actual Gold group rather than
guessed from its rendered sphere. `Socket_30` exposes
`Annodization Voltage (Thin Film)`, and `Math.139` multiplies it by `1.62`
before the result reaches every Metallic BSDF node as nanometer thickness.
`Socket_14` supplies the source default thin-film IOR of `2.46`. The source
description identifies 146–152 V as a rose-gold range, so the matched control
point uses:

```text
150 V * 1.62 nm/V = 243 nm
```

The browser expresses those same constants through MaterialX
`generalized_schlick_bsdf.thinfilm_thickness` and `thinfilm_ior`. The matched
Cycles/direct-light sphere reaches RGB RMSE `0.061831`, luminance correlation
`0.998885`, and mean luminance `0.231857 / 0.219482` for Blender/web.

This is deliberately a uniform probe. The Gold group defaults `Socket_29` to
`1.0`, enabling a second branch that adds noise-driven film streaks scaled up
to 1,390 nm. That spatial discoloration branch remains open and is not hidden
inside the constant-input parity claim.

## Required regression evidence

- extraction determinism and source fingerprint;
- reachable node-type and nested-group inventory;
- constant-input unit probes for both `F82` and `PHYSICAL_CONDUCTOR` — complete;
- anisotropy rotation and tangent-direction probes — complete;
- uniform thin-film thickness/IOR probe — complete;
- procedural thin-film streak/discoloration branch;
- Blender and browser renders using one shared studio environment;
- explicit capability reports when the MaterialX or portable backend cannot
  represent a branch;
- no dependency on material or node-group display names when the graph
  topology and socket contract are sufficient.
