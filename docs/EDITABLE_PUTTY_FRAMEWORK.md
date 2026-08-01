# Editable Bubble Putty framework

The Bubble Putty lab is available at `/paint?engine=putty` and from **Paint → Bubble Putty** in the Studio menu.

## Authoring model

`EditablePuttyDocument` stores a serializable list of source blobs. Each blob has a stable id, a 3D position, and a radius. The document owns selection and the add, move, resize, duplicate, delete, and reset operations.

The live viewport turns those blobs into one Marching Cubes field. Overlapping blobs therefore fuse immediately while the user edits instead of behaving like unrelated meshes.

## Blender-authored rebuild

The source file at `/Users/ahmadjalil/Documents/No3d Tools/bubble-putty-generator.blend` drives the quality pass through the extracted `Bubble Putty Generator_9OCT2024_01` Geometry Nodes group.

The original `.blend` stores a fixed `putty structure1` collection containing three demonstration dowels. Before each evaluation, the worker replaces that collection with closed icosahedron objects generated from the current editable blobs. Positions and radii are converted into the target object's coordinate space. This keeps the authored collection-based graph intact while making its result respond to added and moved putty.

The authoring preview stays interactive; **Rebuild Blender putty** deliberately runs the full graph and replaces the preview with the authored mesh. Any later edit returns to the live preview until the next rebuild.

## Reuse

- `src/editable-putty.ts` is the renderer-independent document model and seed serializer.
- `src/putty-lab.ts` owns Three.js rendering and pointer interaction.
- `collectionSpheres` in `src/blend-import-worker.ts` adapts an editable sphere document to any extracted Geometry Nodes graph whose input contract is a collection of mesh objects.
- `ico-spheres` in the GN-VM seed contract adapts the same document to a direct Geometry input.

This separation lets another putty-like tool keep the document and worker adapter while replacing the preview material, controls, or Blender node group.
