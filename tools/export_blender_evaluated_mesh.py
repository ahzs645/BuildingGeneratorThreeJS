"""Export one Blender object's evaluated surface for GN-VM surface diffs.

Run configuration helpers before this script when an asset is hidden behind a
wrapper. Example:

  blender --background FILE.blend \
    --python tools/configure_n03d_reference.py \
    --python tools/export_blender_evaluated_mesh.py -- OBJECT OUT.json LOCAL

The JSON shape is accepted directly by ``tools/mesh-surface-diff.ts``.
"""

import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 2:
    raise RuntimeError("expected OBJECT_NAME OUT.json [LOCAL]")

object_name = args[0]
out_path = os.path.abspath(args[1])
local_space = len(args) > 2 and args[2].upper() == "LOCAL"
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f'object not found: "{object_name}"')

original_matrix_world = obj.matrix_world.copy()
evaluate_local_space = os.environ.get("NODE_DOJO_EVALUATE_LOCAL_SPACE") == "1"
if evaluate_local_space:
    # Some generators observe their modifier object's transform through
    # Relative Object Info. Use the same identity generator transform as the
    # browser and render_blender_reference.py; LOCAL below remains only an
    # output-coordinate choice.
    obj.location = (0, 0, 0)
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)
    obj.update_tag()

# Evaluate in an isolated scene, matching the reference renderer. Objects in
# supplied asset-library scenes are frequently hidden or excluded through
# collection/view-layer state even though their Geometry Nodes output renders
# correctly once linked into a clean scene.
original_scene = bpy.context.window.scene
export_scene = bpy.data.scenes.new("__NODE_DOJO_EVALUATED_MESH_SCENE")
export_scene.collection.objects.link(obj)
bpy.context.window.scene = export_scene
obj.hide_render = False
obj.hide_viewport = False
obj.hide_set(False)

realize_group = None
realize_modifier = None
if os.environ.get("NODE_DOJO_SKIP_REALIZE") != "1":
    # Blender renders Geometry Nodes instances even when Object.to_mesh()
    # returns only the pre-realized mesh component. Match the reference
    # renderer by appending a temporary realization pass before evaluation.
    realize_group = bpy.data.node_groups.new(
        "__EXPORT_EVALUATED_REALIZE_INSTANCES",
        "GeometryNodeTree",
    )
    realize_group.interface.new_socket(
        name="Geometry",
        in_out="INPUT",
        socket_type="NodeSocketGeometry",
    )
    realize_group.interface.new_socket(
        name="Geometry",
        in_out="OUTPUT",
        socket_type="NodeSocketGeometry",
    )
    realize_input = realize_group.nodes.new("NodeGroupInput")
    realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
    realize_output = realize_group.nodes.new("NodeGroupOutput")
    realize_group.links.new(
        realize_input.outputs["Geometry"],
        realize.inputs["Geometry"],
    )
    realize_group.links.new(
        realize.outputs["Geometry"],
        realize_output.inputs["Geometry"],
    )
    realize_modifier = obj.modifiers.new(
        name="__EXPORT_EVALUATED_REALIZE_INSTANCES",
        type="NODES",
    )
    realize_modifier.node_group = realize_group

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
if mesh is None:
    raise RuntimeError(f'evaluated mesh unavailable: "{object_name}"')

try:
    mesh.calc_loop_triangles()
    transform = None if local_space else evaluated.matrix_world
    positions = [
        list(vertex.co if transform is None else transform @ vertex.co)
        for vertex in mesh.vertices
    ]
    normal_transform = None if transform is None else transform.to_3x3().inverted().transposed()
    vertex_normals = [
        list(vertex.normal if normal_transform is None else (normal_transform @ vertex.normal).normalized())
        for vertex in mesh.vertices
    ]
    corner_normals = [
        list(
            corner.vector
            if normal_transform is None
            else (normal_transform @ corner.vector).normalized()
        )
        for corner in mesh.corner_normals
    ]
    faces = [list(polygon.vertices) for polygon in mesh.polygons]
    loop_triangles = [list(triangle.vertices) for triangle in mesh.loop_triangles]
    material_names = [material.name if material else None for material in mesh.materials]
    face_materials = [
        material_names[polygon.material_index]
        if polygon.material_index < len(material_names)
        else None
        for polygon in mesh.polygons
    ]
    payload = {
        "object": object_name,
        "space": "LOCAL" if local_space else "WORLD",
        "positions": positions,
        "vertex_normals": vertex_normals,
        "corner_normals": corner_normals,
        "faces": faces,
        "loop_triangles": loop_triangles,
        "face_materials": face_materials,
        "stats": {
            "verts": len(mesh.vertices),
            "edges": len(mesh.edges),
            "faces": len(mesh.polygons),
            "triangles": len(mesh.loop_triangles),
        },
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
finally:
    evaluated.to_mesh_clear()
    if realize_modifier is not None:
        obj.modifiers.remove(realize_modifier)
    if realize_group is not None:
        bpy.data.node_groups.remove(realize_group)
    if evaluate_local_space:
        obj.matrix_world = original_matrix_world
    bpy.context.window.scene = original_scene
    bpy.data.scenes.remove(export_scene)

print(
    "BLENDER_EVALUATED_MESH_OK "
    f"{out_path} ({payload['stats']['verts']} verts, "
    f"{payload['stats']['faces']} faces, "
    f"{payload['stats']['triangles']} triangles)"
)
