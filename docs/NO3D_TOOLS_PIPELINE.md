# No3d Tools Geometry Nodes pipeline

The local library, referred to here as `$NO3D_TOOLS_DIR`, contains 47 Blender
files. It may live anywhere on the importing machine. These files are source
assets, not application dependencies:
BlendBridge copies a user-selected file into transient storage, extracts a
portable JSON dump with Blender, returns it to the browser, and removes the
copy. It never modifies the source `.blend`.

The current file-by-file and node-closure results live in
[`NO3D_TOOLS_FULL_COMPATIBILITY_AUDIT.md`](./NO3D_TOOLS_FULL_COMPATIBILITY_AUDIT.md).
That report is authoritative for counts and remaining gaps; this document
describes the pipeline contract.

The non-destructive recovered-font workflow, direct text-helper sweeps, and
matched Blender/WebGL evidence are recorded in
[`NO3D_FONT_PARITY_AUDIT.md`](./NO3D_FONT_PARITY_AUDIT.md).

## Import boundary

1. The local Vite endpoint accepts plain, Gzip-compressed, or
   Zstandard-compressed `.blend` envelopes, validates the header and 1 GiB
   upload limit, and runs `tools/dump_blend.py` in background Blender.
2. Extractor 1.6 records node groups, stable interface/socket identifiers,
   modifier bindings and viewport/render enablement, object/collection
   dependencies, materials, curves, bounded base meshes, and source-packaging
   warnings.
3. Small base meshes are embedded as before. Direct Geometry Nodes modifier
   objects may additionally embed bases up to 250,000 vertices within a
   1,000,000-vertex per-dump budget. Referenced Object/Collection Info geometry
   is discovered from every full-file root as well. Every embedded base or
   evaluated mesh must also fit the exact serialized-JSON budget: 64 MiB per
   object and 128 MiB per dump by default. An omitted modifier or dependency
   base is reported and can be recovered with a target-aware extraction.
4. Available constant-path STL inputs can be embedded as SHA-256-tagged
   triangle soup. Dynamic, missing, malformed, oversized, or over-200k-triangle
   STL inputs remain explicit compatibility failures.
5. Unpacked missing fonts and images are reported in
   `extraction_metadata.warnings` and shown in Studio.
6. `tools/repair_blend_dependencies.py` can build a separate repaired copy from
   an authorized asset directory. Only case-insensitive exact filenames are
   accepted. Images are decoded and packed; STLs are copied to a relative
   sidecar and rebound. A SHA-256 manifest records every recovered and
   unresolved dependency.

## Target and preset boundary

BlendBridge discovers:

- every Geometry Nodes modifier, retaining its complete Blender modifier-array
  index; and
- every top-level reusable Geometry Node group that is not only a nested
  dependency.

For each target, Studio derives an input contract:

- pure generator;
- authored object geometry;
- recommended primitive/curve seed;
- target-aware extraction needed;
- or previous modifier-stack output needed.

The inference also surfaces unbound Object, Collection, Image, and Material
inputs without inventing replacements. Graph edits remain in the Studio draft
and can be exported as portable JSON; they are not claimed to round-trip into
the `.blend`.

## Runtime boundary

Studio and API callers share the typed `runGeometryTarget` contract.

- Object targets evaluate all earlier viewport-enabled Geometry Nodes modifiers
  in order. Each modifier retains its own saved inputs. UI overrides and
  explicit replacement seeds apply only to the selected modifier. A disabled
  modifier can still be selected explicitly for diagnostics without causing it
  to run implicitly in later viewport targets.
- Reusable groups bind their exposed interface directly and accept cube, plane,
  curve-line, curve-circle, or extracted-object seeds.
- Object and group targets select Geometry sockets by stable identifier rather
  than DOM state or custom event payloads.
- Studio evaluations run in replaceable workers with a 180-second safety
  limit. The reproducible corpus audit below uses a stricter 30-second
  per-target probe budget.
- Graph edits debounce for 250 ms. A failed evaluation reports diagnostics and
  retains the last valid viewport result.
- Topology-derived interpretation layers may add reversible portable nodes to
  the evaluated/exported draft without mutating the extracted authoring graph.
  The caliper uses this boundary for zero offset and `mm`/`in` LCD conversion,
  so the modeled String to Curves result—not only the panel readout—changes.

Automatic live evaluation is disabled when a closure:

- contains an unsupported node or missing nested group;
- reaches a resource-bounded volume-grid approximation; or
- contains more than 500 reachable nodes.

The target remains available through the explicit Apply action.

## Compatibility truth contract

Studio reports four different facts separately:

1. **Exact static closure**: every reachable node/mode has an exact handler.
2. **Portable static closure**: every reachable node can execute, including
   declared bounded approximations.
3. **Runtime result**: the selected inputs produced geometry, empty output, a
   diagnostic, or exceeded the budget.
4. **Blender parity**: a checked-in Blender reference proves the result for
   fixed inputs.

A registered handler is not parity evidence. Current bounded approximations
include UV unwrap/packing and the sparse volume-grid slice. They remain visible
in both static and executed coverage.

## Reproducible library audit

`tools/audit-no3d-dumps.ts` discovers every target in a dump directory, applies
the inferred seed/stack contract, and executes each portable target in an
isolated process:

```bash
node --import tsx tools/audit-no3d-dumps.ts /path/to/dumps \
  --output /tmp/no3d-runtime-audit.json \
  --timeout-ms 30000 \
  --concurrency 3
```

Optional `--replace stem=/path/to/refreshed.json` arguments let an audit use a
fresh target-aware or extractor-version-specific dump without copying the
entire corpus.

## Known remaining boundaries

- The absent McMaster-Carr STLs in `corner-mounted-skadis` are not fabricated.
- Multi-item Bake boundaries pass every dynamic socket through during live
  evaluation. Extraction adds an explicit `bake_contract` for every item.
  `tools/attach_bake_snapshots.ts` now attaches typed portable v2 snapshots:
  complete geometry sets (meshes, curves, and instances), dense volume grids,
  and literal socket values. Existing realized-mesh v1 snapshots still load
  and are upgraded when the attachment tool rewrites a dump. Blender's private
  native cache serialization is not treated as an interchange format.
- The eight original files retain their authored external font paths. The
  non-destructive `Font Repaired` copies contain the recovered fonts. The 19
  missing image datablocks are seven unique files—five Preciva maps, a BIC
  logo, and one shared JPEG—and are material-only, so they do not block
  Geometry Nodes output.
- The shared lighter NURBS helper now moves retained authored controls and
  re-evaluates the NURBS spline. Spike Putty and Voronoi Putty no longer return
  empty top-level output; their remaining topology delta is the already
  reported dense-volume approximation/budget boundary.
- The collection contains 89 Linear Gizmos and 13 Dial Gizmos. They remain
  editor-only sinks for geometry evaluation, but Studio now traces nested and
  component-level bindings back to root inputs and exposes working controls
  and positioned direct viewport drag handles. The caliper retains a
  specialized jaw/measurement overlay on top of that shared path.
- Chrome Crayon and Pixel Markers contain active node-tree F-curves. The dump
  now retains their Actions, keyframes, interpolation, FPS, and frame range;
  BlendBridge supplies the requested evaluation frame.
- Blender scene-unit metadata is serialized and displayed. Thirty-one audited
  scenes use Metric millimetres (`scale_length=.001`) and sixteen use Metric
  metres (`scale_length=1`); imported reference scaling remains explicit.
- Seven reachable Warning nodes now emit their authored validation/status text
  as typed Studio diagnostics.
- Four targets exceeded the 30-second concurrent runtime probe budget. The
  Gabor volume modifier completed the corrected concurrent audit in 27.4
  seconds after edge-BVH and field-allocation optimizations, while Apple
  Magsafe and Putty Flange still exceed a 60-second isolated budget.
- Geometry Proximity now skips an unused point KD-tree for face/edge modes and
  shares each query batch between Position and Distance outputs. This removes
  duplicate closest-surface work without changing Blender float32 results.
- Nylon Bolt's visible modifier is exact at 8,735 / 10,070. Its later
  `cl_thumbs` modifier is authored viewport-disabled and remains an explicit
  diagnostic target rather than part of the default evaluated stack.
- Menu Switch supports Geometry/Field selection, named item masks, raw strings,
  and opaque datablock identity values.
- Empty closure identity, callable Closure zones, and exact Blender-derived 2D
  and 3D Gabor modes are supported.
- Blender 5.1.2 fixtures now cover disconnected and seam-split UV charts,
  open/non-manifold/flipped-face SDF inputs, four Grid to Mesh adaptivity
  levels, and a 1,225,043-sample budget case. Developable non-seam UV strips
  unfold continuously; explicit seams cut charts. Open and non-manifold
  polygon soups match Blender's canonical topology exactly.
- Grid to Mesh Adaptivity is functional and monotonic rather than ignored.
  The canonical cube now matches Blender at `0`, `.1`, `.5`, and `1`, including
  vertex, edge, face, triangle, and quad counts. Small meshes use deterministic
  crease-aware collapse; meshes above 2,048 vertices use validated independent
  batch collapses. General topology remains bounded because GN-VM does not
  reproduce OpenVDB's sparse-tree error metric.
- Dense SDF coarsening is no longer silent: runtime diagnostics expose
  requested/effective spacing and sample counts, the active cap, and whether
  the cap changed the lattice. These typed details pass through workers into
  Studio and BlendBridge. Manual previews can explicitly select a 1M, 4M, 12M,
  or 16M dense-sample cap.
- Seam-heavy cyclic UV charts now split corner wedges at authored seams and
  distribute curved-cycle closure error deterministically. Angle Based and
  Conformal use distinct bounded objectives, while developable charts retain
  the exact rigid-unfold path. UV Pack Islands reconstructs disconnected and
  UV-discontinuous islands from topology and packs them independently with a
  deterministic maximal-free-rectangle search and a safe high-island-count
  fallback. This uses atlas space more effectively than the previous fixed
  grid while preserving the bounded classification.
- BlendBridge can preview any linked Viewer node, routing nested Viewers
  through temporary cloned group outputs. It also preserves extracted nested
  modifier panels and Blender-hidden controls, and exposes String sockets so
  authored modeled text displays can be edited beyond the caliper-specific
  adapter.
- Exact general parity is still not claimed for curved cyclic ABF/LSCM UV
  distortion, arbitrary island packing, or arbitrary adaptive OpenVDB surfaces.
