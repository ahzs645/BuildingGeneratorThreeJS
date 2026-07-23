# Metallic BSDF+ reference audit

Audit date: 2026-07-23

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

- two packed scratch textures become sampler uniforms, but the current ESSL
  adapter does not bind filename inputs;
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

## Required regression evidence

- extraction determinism and source fingerprint;
- reachable node-type and nested-group inventory;
- constant-input unit probes for both `F82` and `PHYSICAL_CONDUCTOR`;
- anisotropy rotation and tangent-direction probes;
- thin-film thickness/IOR probes;
- Blender and browser renders using one shared studio environment;
- explicit capability reports when the MaterialX or portable backend cannot
  represent a branch;
- no dependency on material or node-group display names when the graph
  topology and socket contract are sufficient.
