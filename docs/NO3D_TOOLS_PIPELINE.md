# No3d Tools Geometry Nodes pipeline

The local library at `/Users/ahmadjalil/Documents/No3d Tools` contains 47
Blender files. They are source assets, not application dependencies:
BlendBridge copies a user-selected file into transient storage, extracts a
portable JSON dump with Blender, returns it to the browser, and removes the
copy. It never modifies the source `.blend`.

The current file-by-file and node-closure results live in
[`NO3D_TOOLS_FULL_COMPATIBILITY_AUDIT.md`](./NO3D_TOOLS_FULL_COMPATIBILITY_AUDIT.md).
That report is authoritative for counts and remaining gaps; this document
describes the pipeline contract.

## Import boundary

1. The local Vite endpoint accepts plain, Gzip-compressed, or
   Zstandard-compressed `.blend` envelopes, validates the header and 1 GiB
   upload limit, and runs `tools/dump_blend.py` in background Blender.
2. Extractor 1.5 records node groups, stable interface/socket identifiers,
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
- Eight files need their external fonts packed or replaced, and the source
  library still contains unresolved image uses.
- Four targets exceeded the 30-second concurrent runtime probe budget. The
  Gabor volume modifier completed the corrected concurrent audit in 27.4
  seconds after edge-BVH and field-allocation optimizations, while Apple
  Magsafe and Putty Flange still exceed a 60-second isolated budget.
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
  Its zero and fully coarse cube endpoints match Blender topology; intermediate
  topology remains bounded because GN-VM uses deterministic dense clustering
  instead of OpenVDB's sparse-tree error metric.
- Dense SDF coarsening is no longer silent: runtime diagnostics expose
  requested/effective spacing and sample counts, the active cap, and whether
  the cap changed the lattice. Manual previews can explicitly raise the cap.
- Exact general parity is still not claimed for curved cyclic ABF/LSCM UV
  charts, arbitrary island packing, or intermediate adaptive OpenVDB topology.
