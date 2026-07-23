# Node Dojo Blender ↔ browser/GN-VM parity audit

Date: 2026-07-09

> **Historical snapshot.** This document preserves the July 9 investigation and
> its then-current measurements. Later fixes supersede several findings,
> especially Bubble Vase topology/surface parity, browser materials, and bin
> selection counts. Use
> [`NODE_DOJO_MAINTAINERS_GUIDE.md`](NODE_DOJO_MAINTAINERS_GUIDE.md) for the
> current architecture, terminology, catalog, residuals, and evidence workflow;
> use each asset's `status.json` as current machine-readable truth. The resolved
> vase checkpoint is in [`VASE_SEAM_HANDOFF.md`](VASE_SEAM_HANDOFF.md).

## Scope

This audit treats the independent TypeScript Geometry Nodes VM as the browser implementation (“R/browser version”) and Blender's evaluated modifier output as truth. Blender-baked gallery GLBs are audited separately because their geometry is already Blender output; for those assets, the meaningful risks are export determinism and browser material/lighting reconstruction.

Checks performed:

- fresh Blender GLB exports from the supplied `.blend` files;
- 15 bin parameter combinations;
- 9 vase parameter combinations, including a high-resolution stress case;
- bidirectional point-to-triangle surface distances;
- vertex/face counts, bounds, triangle area, components, caps, and axial fans;
- per-material face/triangle allocation;
- GLB PBR material, texture, and embedded-image payloads;
- live browser comparisons of Blender-baked and GN-VM bin settings;
- original versus studio material views for the textured hat.

## Executive summary

1. The checked-in Blender truth files are trustworthy. Fresh bin and vase exports are byte-for-byte identical to `public/dojo/bin.glb` and `public/dojo/vase_truth.glb`.
2. The bin VM gets the overall envelope right for 14/15 tested cases, but its interior bin geometry is not surface-identical. Typical bidirectional p99 surface errors are `0.008–0.018`, with one layout reaching a `0.047` maximum.
3. Bin material/selection topology is also different: normal selections have 212 red triangles in Blender versus 326 in the VM, and the auxiliary `emit.003` geometry follows a different selection order for most indices.
4. Vase baseline parity is good but does not generalize to all controls. `bubble density=80` reaches p99 ≈ `1.18` and a `10.80` maximum; `bottom cut=15` moves the bottom surface by `2.338`; low resolution doubles the VM's top-cap triangle count.
5. Vase evaluation performance is a major issue. Blender evaluates these cases in `0.25–1.05 s`; GN-VM takes `24–103 s`. `Resolution=0.6` did not finish within an isolated 180-second timeout.
6. The gallery currently defaults to a studio override that intentionally discards Blender materials. The hat does carry three valid 2048² embedded textures, but its original metallic material renders nearly black because the gallery has no image-based environment lighting.

## Remediation verification — 2026-07-10

The correctness-first fixes from this audit are now implemented and remeasured:

| Case | Before | After |
| --- | --- | --- |
| Vase baseline | p99 `.448/.594`, max `1.378` | unchanged; 698 axial-fan triangles, zero centroid outliers >2 |
| `bubble density=80` | p99 `1.181/1.173`, max `10.797` | p99 `.455/.500`, max `1.604` |
| `bottom cut=15` | p99 `2.338/.800` | p99 `.606/.686`; cap on z=0 cutter plane |
| `Resolution=.3` top cap | VM 930 vs Blender 466 triangles | VM 468 vs Blender 466 triangles |
| `Resolution=.6` | timeout at 180 s | completes in `100.3 s` with 179,968 vertices |
| Baseline VM generation | roughly 80 s | `44.3 s` |

The density defect was an antiparallel singularity in `Align Euler to Vector`: one 10-point radial target instance was reflected through Z near y=0. All 760 Proximity target points are present; after the stable AUTO-pivot fix, the seam outliers disappear.

The bottom-cut defect came from projecting a minimum-side Boolean cap onto an interior sampled ring. Minimum-side cuts now use the exact cutter plane. Maximum-side large-shell caps retain the sampled ring, and coplanar overlap faces are removed; this fixes the low-resolution doubled cap without deleting the valid axial fan.

Topology construction is now lazy, cached without repeated whole-mesh hashing, and uses numeric canonical-edge keys for normal browser-sized meshes. This is responsible for the large evaluation-time reduction.

An isolated `Fillet Curve` check found all 56 generated points exactly equal to Blender, including Poly Count and radius limiting. A global winding experiment regressed real bin envelopes and was rejected. Feeding Blender's exact 16-island pre-selection mesh into the `choose bin` group produces identical selections for all indices 0–11 in Blender and GN-VM; the remaining bin ordering difference is therefore upstream in geometry/realization construction, not Mesh Island numbering or the fillet arc math.

Browser materials now come from dumped Principled/Emission inputs, no-material faces use glTF white, baked roughness is preserved, and the gallery defaults to original materials under a PMREM `RoomEnvironment`. A non-destructive attempt to freeze embroidery against the base hat did not eliminate the hat's 4–5 split-vertex variation, so it was rejected. The stable contract remains 759,734 triangles and the same three texture payloads; deterministic vertex splitting requires editing the source graph to remove one side of the dependency cycle.

## Truth-export integrity

| Asset | Fresh Blender export result |
| --- | --- |
| Recursive bin | Byte-identical |
| Bubble vase baseline | Byte-identical |
| Chrome Crayon | Byte-identical |
| Schoen Gyroid | Byte-identical |
| Schwarz P-Surface | Byte-identical |
| Send Nodes Hat | Same 759,734 triangles and texture payload, but 395,046–395,050 exported vertices across repeated runs |

The hat's small vertex-count instability is upstream in Blender: the file reports a dependency cycle between `hat front` and `embroidery crv`. Repeated exports retain the same triangle count and textures but vary by a few split vertices.

## Bin geometry sweep

Distances are in Blender units. `B→VM` samples Blender vertices against the VM triangle surface; `VM→B` measures the reverse direction.

| Case | VM vertex delta | Max bounds delta | B→VM p99 | VM→B p99 |
| --- | ---: | ---: | ---: | ---: |
| divide x=.15, y=.2 | +1.20% | 0 | .017 | .018 |
| divide x=.15, y=.633 | +1.31% | 0 | .017 | .018 |
| divide x=.15, y=.9 | +0.96% | 0 | .002 | .016 |
| divide x=.417, y=.2 | +1.28% | 0 | .005 | .018 |
| divide x=.417, y=.633 | +1.24% | 0 | .014 | .018 |
| divide x=.417, y=.9 | +1.21% | 0 | .011 | .018 |
| divide x=.85, y=.2 | +1.17% | 0 | .016 | .018 |
| divide x=.85, y=.633 | +1.22% | 0 | .017 | .018 |
| divide x=.85, y=.9 | +3.88% | 0 | .007 | .018 |
| fillet=.3 | +0.85% | 0 | .001 | .008 |
| fillet=2.5 | -0.26% | 0 | .017 | .018 |
| Bin Select=0 | +1.22% | 0 | .014 | .018 |
| Bin Select=11 | +1.30% | .0069 | .017 | .017 |
| wall thickness=4 | +1.73% | 0 | .008 | .016 |
| Size X=1.2, Size Y=.8 | +1.26% | 0 | .014 | .017 |

Notable maxima:

- `divide x=.417, y=.2`: Blender→VM max `0.047` on top/interior edges.
- Normal cases: VM→Blender max is typically `0.019–0.026`.
- `Bin Select=11`: VM minimum X extends `0.0069` farther than Blender and both directions have non-zero median error.

Baseline triangle-area totals are `2.281` in Blender and `2.343` in the VM (+2.7%). Blender has 109,938 triangles versus 111,736 in the VM. The mismatch is therefore not only a different vertex split; it changes surface area and placement.

### Bin material allocation

Baseline evaluated face counts:

| Material | Blender faces | VM faces | Delta |
| --- | ---: | ---: | ---: |
| `3D` (blue bin geometry) | 48,120 | 48,691 | +571 |
| `3D.004` (red selection) | 100 | 140 | +40 |
| no material (drawer body) | 3,219 | 3,251 | +32 |
| `ankermake bed` | 1 | 1 | 0 |
| `emit.003` | 3,440 | 3,440 | 0 |

For ordinary `Bin Select` variants, Blender exports 212 red triangles while GN-VM exports 326. `emit.003` triangle counts match at selections 0, 5, and 10 but follow a different ordering for most other indices. This points to an instance/index ordering mismatch in addition to the curve/topology difference.

`Bin Select=10` turns nearly the complete bin mesh red in both Blender and GN-VM. That unusual state is source behavior, not a VM-only regression.

### Likely bin geometry source

The strongest current target is `GeometryNodeFilletCurve`/`filletSpline` followed by Curve to Mesh and extrusion:

- lowering `fillet` to `.3` improves p99 from approximately `.014/.018` to `.001/.008`;
- the residual is concentrated in `3D` and `3D.004`, not the print bed or `emit.003` baseline geometry;
- the bin graph contains no Mesh Boolean node on this path.

The selection-order mismatch should be investigated independently in instance realization/index semantics.

## Vase parameter sweep

| Case | VM vertex delta | Max bounds delta | B→VM p99 | VM→B p99 | Largest observed error |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | +0.69% | .686 | .448 | .594 | 1.378 |
| Resolution=.3 | +0.73% | .408 | .676 | .774 | 4.823 |
| Resolution=.6 | — | — | — | — | GN-VM timed out at 180 s |
| Wall thickness=20 | +0.18% | 1.438 | .432 | .589 | 2.511 |
| Wall thickness=50 | +0.75% | .458 | .357 | .414 | 1.640 |
| bubble density=30 | +0.70% | 1.337 | .320 | .341 | 1.930 |
| bubble density=80 | +0.70% | 1.161 | 1.181 | 1.173 | 10.797 |
| bottom cut=15 | -2.19% | .025 | 2.338 | .800 | 2.338 |
| drop=false | +0.69% | .694 | .418 | .599 | 1.381 |

Important topology/region details:

- Baseline preserves the 698-triangle axial fan.
- `bubble density=80` also preserves 698 fan triangles, but the side envelope diverges severely near `y≈0`; the top plane is `0.937` higher in the VM and has a smaller radius/area.
- `bottom cut=15` preserves 698 fan triangles, but Blender's bottom plane is at `z=0` while the corresponding VM surface is offset by `2.338` over a broad central region. This is hidden by the nearly identical overall bounds.
- At `Resolution=.3`, Blender has 472 fan triangles versus 466 in the VM. Blender's top cap has 466 triangles; the VM has 930, almost exactly double.
- Blender's `Resolution=.6` output is 179,825 vertices / 179,825 faces and evaluates in about 1.05 s. The isolated GN-VM run remained CPU-bound until its hard 180-second timeout.

### Likely vase sources

1. High bubble density: field sampling/instance ordering around Resample Curve and Geometry Proximity. The large errors occur near the `y=0` sector and are not explained by the retained axial fan.
2. Bottom cut: FLOAT-path Boolean/clipping and cap placement. The `2.338` flat bottom offset is much larger than the rest of the shell error.
3. Low resolution: cap/fan construction after resampling. The doubled top-cap triangle count is a concrete topology discrepancy.
4. Performance: repeated evaluation and Boolean/proximity work currently scales far worse than Blender. Add per-case timeouts before using broad automated sweeps in CI.

## Material and texture audit

### Bin

The Blender GLB contains four flat materials and no textures or images:

- `3D`: base `[0, .0309826, 1, 1]`, metallic `0`, roughness `.5`;
- `3D.004`: base `[1, 0, .002402, 1]`, metallic `0`, roughness `.5`;
- `emit.003`: black base with white emission;
- `ankermake bed`: white, roughness `.9`, unlit, alpha blend.

Browser deviations:

- `gnvm-viewer.ts` reconstructs approximate hard-coded materials. No-material drawer faces become gray `0x8d97a3` instead of GLTFLoader's white default; red is pinker and emissive behavior differs.
- `bin-studio.ts` loads Blender's GLB but forces every material's roughness to `.55`, changing the source `.5`, `.9`, and `1.0` values.
- The gallery's default `studio` mode replaces all source materials with one accent material. Selecting `original` restores the GLB payload.

### Gallery assets

| Asset | Materials | Textures/images | Notes |
| --- | ---: | ---: | --- |
| Chrome Crayon | 1 | 0 | black base + white emission |
| Schoen Gyroid | 1 | 0 | white emission, alpha blend |
| Schwarz P-Surface | 1 | 0 | white emission, alpha blend |
| Send Nodes Hat | 1 | 3 | base color, normal, metallic/roughness |

The hat embeds all three PNGs correctly:

- normal: 2048×2048, 9,061,353 bytes;
- base color: 2048×2048, 6,307,165 bytes;
- metallic/roughness: 2048×2048, 3,689,184 bytes.

In `original` mode the textures are present, but the hat renders nearly black because its material is metallic and the gallery provides direct lights without a PMREM/image-based environment. `studio` mode makes the shape readable by discarding all three texture maps. The correct browser fix is to preserve the original PBR material and add a neutral environment map, not to replace the material.

## Prioritized fixes

1. **Vase density and bottom-cut semantics:** fix Geometry Proximity/resampling at high density and FLOAT Boolean bottom-cap placement.
2. **Vase performance guardrails:** isolate evaluations per process/worker with a timeout; profile Resolution and proximity/Boolean scaling.
3. **Bin Fillet Curve parity:** validate Blender's Poly mode, Count semantics, radius limiting, and adjacent-corner clamping before Curve to Mesh.
4. **Bin instance/index ordering:** compare realized-instance order and selection fields across all 12 `Bin Select` values.
5. **Material reconstruction:** derive GN-VM Three.js materials from dumped Blender material nodes instead of a name-based palette; preserve no-material white.
6. **Viewer fidelity:** remove the baked-bin roughness override, default gallery bakes to `original`, and add PMREM/RoomEnvironment for textured metallic assets.
7. **Hat source graph:** break or freeze the `hat front` ↔ `embroidery crv` dependency cycle if deterministic vertex splits are required.

## Reproduction

Bin Blender sweep with per-case GLBs:

```sh
blender -b BIN.blend --python tools/parity_sweep.py -- \
  /tmp/bin-blender.json /tmp/bin-truth
```

GN-VM sweep with per-case JSON meshes:

```sh
node --import tsx tools/gnvm-sweep.ts \
  public/dojo/dump_bin.json /tmp/bin-vm.json /tmp/bin-blender.json /tmp/bin-vm
```

Vase sweep:

```sh
blender -b VASE.blend --python tools/parity_sweep.py -- \
  /tmp/vase-blender.json /tmp/vase-truth 'BUBBLE VASE' tools/parity-cases-vase.json

node --import tsx tools/gnvm-sweep.ts \
  public/dojo/dump_bubble.json /tmp/vase-vm.json /tmp/vase-blender.json \
  /tmp/vase-vm 'BUBBLE VASE' tools/parity-cases-vase.json
```

Surface and material inspection:

```sh
node --import tsx tools/mesh-surface-diff.ts TRUTH.glb VM.json
node --import tsx tools/glb-material-audit.ts MODEL.glb
```
