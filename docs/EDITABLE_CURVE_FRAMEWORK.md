# Editable curve authoring framework

The Blender brush lab keeps pen input as editable source curves instead of
discarding it after a procedural mesh is generated. The source document lives
in `src/editable-curves.ts`; Chrome Crayon is the first backend adapter in
`src/surface-draw.ts`.

## Source document contract

`EditableCurveDocument` owns:

- stable stroke and point IDs;
- an in-progress pen stroke and committed splines;
- whole-stroke or individual-point selection;
- projected translation and point movement;
- undo, clear, point counts, and backend curve serialization.

Generated meshes never become the authoring source. A tool updates the curve
document, serializes every spline into one shared coordinate system, and asks
its procedural backend for a new result. This is what lets proximity, welding,
and similar graph operations react to intersections between different strokes.

The projection callback passed to `translateSelection()` or
`moveSelectedPoint()` is the environment boundary. A flat editor can return the
proposed point directly. A surface editor can snap it to a BVH, update its
normal, and retain local patch coordinates without adding surface-specific code
to the document.

## Chrome Crayon adapter

The brush lab supports two evaluation spaces:

1. **Flat:** all curve points are sent directly to GN-VM in their shared XY
   coordinates. Moving a stroke changes its distance to every other stroke, so
   the authored Geometry Proximity and Merge by Distance behavior re-evaluates.
2. **Surface patch:** curve points are expressed in the selected patch's local
   `(u, v)` coordinates. GN-VM evaluates the combined planar drawing, then the
   generated mesh is projected back to the target surface. Crossings are kept
   intact; the older arc-length straightening path remains only for the fixed
   curved parity fixture.

The evaluator uses one cached worker. Drag edits are debounced and coalesced:
only one evaluation occupies the worker, and the newest queued edit runs next.
The installed Blender dump and the worker's warmed module/JIT state survive
subsequent edits.

## Adding another procedural drawing tool

1. Create one `EditableCurveDocument` for the tool lifetime.
2. Convert pointer samples into `{ point, normal, local? }` values.
3. Render `document.strokes` as lightweight preview lines and control handles.
4. Supply a projector appropriate to the editing surface.
5. Serialize every committed stroke with `document.toCurves()` into the
   backend's common coordinate system.
6. Regenerate disposable output geometry from that serialized source.
7. Dispose the output mesh independently; never replace the curve document
   with its triangles.

Physics is intentionally outside this contract. Chrome Crayon's
"self-interaction" is procedural proximity and topology rebuilding. Flexible
body motion or true self-collision should consume the same editable curve
document through a separate PBD/Verlet/physics adapter.
