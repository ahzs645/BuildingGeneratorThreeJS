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

The native MaterialX experiment was also run against the file:

```text
Blender 5.1.2 native USD export:
  material: Material
  result: no MaterialX NodeGraph or OpenPBR surface
```

This is an exporter capability boundary, not evidence that the source shader is
invalid. The active material surface is supplied by a nested
`Metallic BSDF+` group, and Blender 5.1 does not flatten that 5.2 graph into the
USD/MaterialX network consumed by the current extractor.

This reference does not directly explain the 3D Chrome Crayon Generator's
remaining `flat.nodes` residual. That material is attribute-driven emission,
not a metallic BSDF. It is nevertheless directly relevant to Chrome Asset
Library metals and future Blender 5.2 material imports.

## Modular implementation path

1. Add a typed, versioned shader graph IR for materials and nested
   `ShaderNodeTree` groups. Preserve socket identifiers, socket types, active
   outputs, menu values, and source Blender version.
2. Add a shader capability analyzer that follows only nodes reachable from the
   active Material Output. Report native MaterialX, portable runtime, baked,
   and unsupported paths separately.
3. Normalize direct `ShaderNodeBsdfMetallic` into a backend-independent
   metallic contract:
   base color, roughness, anisotropy, anisotropic rotation, tangent, normal,
   Fresnel mode, edge tint, conductor optical constants, and thin-film inputs.
4. Implement the simple constant/direct-node contract first in the existing
   Three.js material backend and in MaterialX/OpenPBR where the target supports
   it. Keep unsupported conductor or thin-film semantics explicit.
5. Treat the large `Metallic BSDF+` group as a composition of independently
   testable passes:
   base metallic lobe, layered roughness, grazing-angle roughness, brushed
   anisotropy, scratches/wear, and anodized thin film.
6. Validate a small preset matrix before expanding to all thirty presets:
   Aluminum, Copper, Gold, Stainless Steel, and Titanium cover neutral,
   colored, brushed, and thin-film-relevant behavior.
7. Compare deterministic material probes rendered from identical geometry,
   camera, environment, and color-management settings. Keep geometry parity,
   shader-graph parity, and final raster similarity as separate claims.

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

