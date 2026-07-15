"""Render one active Geometry Nodes object as an isolated Blender reference.

Usage:
  blender --background FILE.blend --python tools/render_blender_reference.py -- \
    OBJECT_NAME OUT.png [OUT.json] [LOCAL]
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def apply_font_override():
    path = os.environ.get("NODE_DOJO_FONT_OVERRIDE")
    if not path:
        return
    replacement = bpy.data.fonts.load(path, check_existing=True)
    basename = os.path.basename(path).lower()
    for group in bpy.data.node_groups:
        for node in group.nodes:
            for socket in node.inputs:
                current = getattr(socket, "default_value", None)
                if getattr(socket, "type", "") == "FONT" and current is not None:
                    if os.path.basename(bpy.path.abspath(current.filepath)).lower() == basename:
                        socket.default_value = replacement
    print(f"NODE_DOJO_FONT_OVERRIDE_OK {replacement.name} <- {path}")


apply_font_override()


args = sys.argv[sys.argv.index("--") + 1:]
object_name = args[0]
out_path = args[1]
meta_path = args[2] if len(args) > 2 else None
local_space = len(args) > 3 and args[3].upper() == "LOCAL"
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f'object not found: "{object_name}"')

override_payload = os.environ.get("NODE_DOJO_OVERRIDES")
if override_payload:
    overrides = json.loads(override_payload)
    modifier = next((candidate for candidate in obj.modifiers if candidate.type == "NODES" and candidate.node_group), None)
    if modifier is None:
        raise RuntimeError(f'Geometry Nodes modifier not found: "{object_name}"')
    identifiers = {
        item.name: item.identifier
        for item in modifier.node_group.interface.items_tree
        if item.item_type == "SOCKET" and item.in_out == "INPUT"
    }
    for name, value in overrides.items():
        identifier = identifiers.get(name)
        if identifier is None:
            raise KeyError(f"modifier input not found: {name}")
        modifier[identifier] = value
    obj.update_tag()
    bpy.context.view_layer.update()
    print(f"NODE_DOJO_OVERRIDES_OK {json.dumps(overrides, sort_keys=True)}")

if local_space:
    obj.location = (0, 0, 0)
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)

# Some supplied scenes retain an old movie-only output setting that rejects PNG
# under Blender 5. A clean reference scene also prevents unrelated presentation
# objects, cameras, and lights from affecting the isolated generator render.
scene = bpy.data.scenes.new("__NODE_DOJO_REFERENCE_SCENE")
scene.collection.objects.link(obj)
bpy.context.window.scene = scene
obj.hide_render = False
obj.hide_viewport = False
obj.hide_set(False)

# Object.to_mesh() can return an allocated but empty mesh when the Geometry
# Nodes result contains only instances (or omit instances beside a mesh
# component). Append a temporary realization pass so the reference image and
# topology report represent what Blender actually renders.
realize_group = bpy.data.node_groups.new("__REFERENCE_REALIZE_INSTANCES", "GeometryNodeTree")
realize_group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
realize_group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
realize_input = realize_group.nodes.new("NodeGroupInput")
realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
realize_output = realize_group.nodes.new("NodeGroupOutput")
realize_group.links.new(realize_input.outputs["Geometry"], realize.inputs["Geometry"])
realize_group.links.new(realize.outputs["Geometry"], realize_output.inputs["Geometry"])
realize_modifier = obj.modifiers.new(name="__REFERENCE_REALIZE_INSTANCES", type="NODES")
realize_modifier.node_group = realize_group

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
mesh_verts = len(mesh.vertices) if mesh else None
mesh_faces = len(mesh.polygons) if mesh else None
if mesh and os.environ.get("NODE_DOJO_SURFACE_BOUNDS") == "1" and mesh.polygons:
    surface_indices = {index for polygon in mesh.polygons for index in polygon.vertices}
    corners = [evaluated.matrix_world @ mesh.vertices[index].co for index in surface_indices]
else:
    corners = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices] if mesh else []
# Evaluated Curve objects can retain their pre-modifier/invalid bound_box even
# when Geometry Nodes produces a large mesh. Prefer realized mesh vertices and
# use the object bounds only as a fallback for non-mesh outputs.
if not corners:
    try:
        for corner in evaluated.bound_box:
            corners.append(evaluated.matrix_world @ Vector(corner))
    except Exception:
        pass
if not corners or all(abs(value + 1.0) < 1e-6 for corner in corners for value in corner):
    corners = [obj.matrix_world.translation.copy()]

minimum = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
maximum = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
center = (minimum + maximum) * 0.5
size = maximum - minimum
radius = max(size.length * 0.5, 0.5)

camera_data = bpy.data.cameras.new("__NODE_DOJO_REFERENCE_CAMERA")
camera = bpy.data.objects.new("__NODE_DOJO_REFERENCE_CAMERA", camera_data)
scene.collection.objects.link(camera)
direction = Vector((1.0, -1.25, 0.85)).normalized()
camera.location = center + direction * radius * 3.0
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = max(size.x, size.y, size.z, 1e-4) * 1.45
camera_data.clip_end = max(1000.0, radius * 6.0)
bpy.context.scene.camera = camera

scene = bpy.context.scene
scene.render.image_settings.file_format = "PNG"
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.display.shading.cavity_type = "BOTH"
scene.display.shading.show_specular_highlight = True
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.filepath = out_path
scene.view_settings.look = "AgX - Medium High Contrast"
bpy.ops.render.render(write_still=True)

if meta_path:
    stats = {
        "object": obj.name,
        "type": obj.type,
        "bbox": {"min": list(minimum), "max": list(maximum)},
        # Blender 5.1 can invalidate the temporary evaluated mesh while the
        # Workbench render runs, so retain its counts before rendering.
        "verts": mesh_verts,
        "faces": mesh_faces,
        "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
    }
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(stats, handle, indent=2)

if mesh:
    evaluated.to_mesh_clear()

print(f"BLENDER_REFERENCE_OK -> {out_path}")
