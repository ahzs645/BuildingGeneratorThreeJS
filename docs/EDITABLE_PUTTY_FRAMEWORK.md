# Editable Bubble Putty framework

The Bubble Putty lab is available at `/paint?engine=putty` and from **Paint → Bubble Putty** in the Studio menu.

## Authoring model

`EditablePuttyDocument` stores a serializable list of source blobs. Each blob has a stable id, a 3D position, and a radius. The document owns selection and the add, move, resize, duplicate, delete, and reset operations.

The live viewport turns those blobs into one Marching Cubes field. Overlapping blobs therefore fuse immediately while the user edits instead of behaving like unrelated meshes.

The **Three pipes** input form exercises the Blender file's original use case. It starts with three intersecting cylindrical meshes and one blue anchor pipe. In **Move putty**, the visible putty controls can be dragged directly; every pointer position is projected back onto the blue cylinder so the material stays attached while moving around its surface. **Place putty**, **Add putty**, and **Duplicate** create more surface-locked material. **Move pipes** is a separate fixture mode. The anchor cannot move there, while either remaining pipe can be dragged relative to it. Selecting another pipe and choosing **Lock selected pipe as anchor** transfers that constraint and reprojects the putty controls to the new surface.

The default joint is intentionally diameter-relative rather than a full-length pipe coating. Each pipe contributes only a compact eight-radius influence span around the crossing, while three small surface controls introduce the asymmetric lobes. This leaves the outer pipe lengths exposed and produces the short sleeve/star silhouette used by the Blender reference. The pipe selection wireframes are editing aids; an authored rebuild shows the clean solid pipes with the generated putty.

## Blender-authored rebuild

The source file at `/Users/ahmadjalil/Documents/No3d Tools/bubble-putty-generator.blend` drives the quality pass through the extracted `Bubble Putty Generator_9OCT2024_01` Geometry Nodes group.

The original `.blend` stores a fixed `putty structure1` collection containing three demonstration dowels. Before each evaluation, the worker replaces that collection with closed icosahedron objects generated from the current editable blobs. Positions and radii are converted into the target object's coordinate space. This keeps the authored collection-based graph intact while making its result respond to added and moved putty.

For the three-pipe input, the adapter installs both closed cylinder meshes and the surface-locked putty spheres into the same collection. Their centers, axes, radii, and lengths are transformed into the authored object's coordinate space before the 53-node graph runs, so the exact rebuild uses the same dragged putty and locked/moved pipe arrangement shown by the interactive preview.

The authoring preview stays interactive; **Rebuild Blender putty** deliberately runs the full graph and replaces the preview with the authored mesh at the same world scale, keeping the fixture visible for a direct proportion check. Any later edit returns to the live preview until the next rebuild.

## Reuse

- `src/editable-putty.ts` is the renderer-independent document model and seed serializer.
- `src/putty-lab.ts` owns Three.js rendering and pointer interaction.
- `collectionSpheres` in `src/blend-import-worker.ts` adapts an editable sphere document to any extracted Geometry Nodes graph whose input contract is a collection of mesh objects.
- `ico-spheres` in the GN-VM seed contract adapts the same document to a direct Geometry input.

This separation lets another putty-like tool keep the document and worker adapter while replacing the preview material, controls, or Blender node group.
