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

Surface projection treats the target as the brush's floor. It rebases the
lowest generated Z value to a small clearance above the closest target point,
then applies the remaining height along interpolated target normals. This keeps
the target depth buffer from cutting through a brush whose authored GN mesh
straddles its input plane.

The evaluator uses one cached worker. Drag edits are debounced and coalesced:
only one evaluation occupies the worker, and the newest queued edit runs next.
The installed Blender dump and the worker's warmed module/JIT state survive
subsequent edits.

## Live Geometry Nodes authoring

The Create brush lab and the Dev parity view use the shared
`chromeCrayonEditorConfig`. They therefore open the same extracted Blender
graph and the same locally saved draft. In Create, `Show node editor` docks the
authoring graph beneath the canvas; mobile uses the equivalent full-screen
overlay.

Every editor document change emits `crayon-graph-change`. The brush runtime
replaces its active Chrome Crayon dump, invalidates only the worker's installed
graph identity, and queues the current editable curves for re-evaluation. The
curve document, camera, selection, and drawn strokes remain intact. This event
boundary is the reusable pattern for mounting a node editor beside another
procedural drawing backend.

## No3d-style flat workspace

`Flat canvas` mirrors the presentation contract recovered from
`no3d-pixel-markers.blend`, rather than pretending a drawing canvas is a lit
3D model. It uses an orthographic camera over a large XY picking plane, a
neutral Workbench-style background, and a pointer-following brush reticle.
The empty document displays the same kinds of helpers authored by the Blender
`dojo_bounding grid` and `draw curve here` groups: framing corners, a pixel
grid, and an active-brush label. Those empty-state guides fade once the first
stroke is committed; selecting a curve reveals the editable source overlay
again without baking it into the chrome render.

The canvas is visually unbounded at ordinary zoom levels. OrbitControls pans
and zooms the orthographic camera, while pointer samples still land in one
shared world-space XY coordinate system, so moving or crossing strokes keeps
the procedural self-interaction contract described above.

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
