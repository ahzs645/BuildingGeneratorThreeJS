"""Render one active Geometry Nodes object as an isolated Blender reference.

Usage:
  blender --background FILE.blend --python tools/render_blender_reference.py -- \
    OBJECT_NAME OUT.png [OUT.json] [LOCAL]

Set ``NODE_DOJO_AUTHORED_MATERIAL=1`` for an isolated Eevee material render,
and ``NODE_DOJO_GN_ONLY=1`` to disable source modifiers after the first active
Geometry Nodes modifier before adding the temporary realization pass.
``NODE_DOJO_AUTHORED_LIGHT_SCALE`` optionally multiplies the authored Area
light powers for large or small assets while preserving the shared rig layout.
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

gn_only = os.environ.get("NODE_DOJO_GN_ONLY") == "1"
if gn_only:
    found_geometry_nodes = False
    for modifier in obj.modifiers:
        if not found_geometry_nodes and modifier.type == "NODES" and modifier.node_group:
            found_geometry_nodes = True
            continue
        if found_geometry_nodes:
            modifier.show_viewport = False
            modifier.show_render = False
    if not found_geometry_nodes:
        raise RuntimeError(f'Geometry Nodes modifier not found: "{object_name}"')

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

debug_material_output = os.environ.get("NODE_DOJO_DEBUG_MATERIAL_OUTPUT", "")
if debug_material_output == "MATH_BEVEL_FACTOR":
    material = bpy.data.materials.get("Filament and Cross Section 1OCT2024")
    if material is None or material.node_tree is None:
        raise RuntimeError("Math Clay filament material not found")
    material_nodes = material.node_tree.nodes
    material_links = material.node_tree.links
    bump = next((node for node in material_nodes if node.bl_idname == "ShaderNodeBump"), None)
    bevel_link = next((link for link in material_links if link.to_node == bump and link.to_socket.name == "Normal"), None)
    bevel_node = bevel_link.from_node if bevel_link else None
    bevel_tree = bevel_node.node_tree if bevel_node and bevel_node.bl_idname == "ShaderNodeGroup" else None
    if bevel_tree is None:
        raise RuntimeError("Math Clay Bevel For Eevee group not found")
    bevel_output = next((node for node in bevel_tree.nodes if node.bl_idname == "NodeGroupOutput"), None)
    bevel_ramp = next((node for node in bevel_tree.nodes if node.bl_idname == "ShaderNodeValToRGB"), None)
    if bevel_output is None or bevel_ramp is None:
        raise RuntimeError("Math Clay Bevel For Eevee factor nodes not found")
    for link in list(bevel_tree.links):
        if link.to_node == bevel_output and link.to_socket.name == "Normal":
            bevel_tree.links.remove(link)
    bevel_tree.links.new(bevel_ramp.outputs["Color"], bevel_output.inputs["Normal"])
    output_node = next((node for node in material_nodes if node.bl_idname == "ShaderNodeOutputMaterial" and node.is_active_output), None)
    if output_node is None:
        raise RuntimeError("Math Clay active Material Output not found")
    emission = material_nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    material_links.new(bevel_node.outputs["Normal"], emission.inputs["Color"])
    material_links.new(emission.outputs["Emission"], output_node.inputs["Surface"])
    print("NODE_DOJO_DEBUG_MATERIAL_OUTPUT_OK MATH_BEVEL_FACTOR")
elif debug_material_output:
    raise RuntimeError(f"unsupported NODE_DOJO_DEBUG_MATERIAL_OUTPUT: {debug_material_output}")

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
evaluated_materials = [material.name if material else None for material in mesh.materials] if mesh else []
evaluated_material_faces = {}
if mesh:
    for polygon in mesh.polygons:
        name = evaluated_materials[polygon.material_index] if polygon.material_index < len(evaluated_materials) else None
        key = name or "<none>"
        evaluated_material_faces[key] = evaluated_material_faces.get(key, 0) + 1
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
authored_material = os.environ.get("NODE_DOJO_AUTHORED_MATERIAL") == "1"
if authored_material:
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None" if debug_material_output else "Medium High Contrast"
    authored_light_scale = float(os.environ.get("NODE_DOJO_AUTHORED_LIGHT_SCALE", "1"))
    key_data = bpy.data.lights.new("__NODE_DOJO_REFERENCE_KEY", "AREA")
    key_data.energy = 1000.0 * authored_light_scale
    key_data.size = radius * 1.5
    key = bpy.data.objects.new("__NODE_DOJO_REFERENCE_KEY", key_data)
    scene.collection.objects.link(key)
    key.location = center + Vector((-1.8, -2.1, 2.8)).normalized() * radius * 2.4
    key.rotation_euler = (center - key.location).to_track_quat("-Z", "Y").to_euler()
    fill_data = bpy.data.lights.new("__NODE_DOJO_REFERENCE_FILL", "AREA")
    fill_data.energy = 500.0 * authored_light_scale
    fill_data.size = radius * 2.0
    fill = bpy.data.objects.new("__NODE_DOJO_REFERENCE_FILL", fill_data)
    scene.collection.objects.link(fill)
    fill.location = center + Vector((2.0, 1.0, 1.0)).normalized() * radius * 2.0
    fill.rotation_euler = (center - fill.location).to_track_quat("-Z", "Y").to_euler()
else:
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
if not authored_material:
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
        "evaluated_materials": evaluated_materials,
        "evaluated_material_faces": evaluated_material_faces,
        "engine": scene.render.engine,
        "authored_material": authored_material,
        "geometry_nodes_only": gn_only,
        "authored_light_scale": authored_light_scale if authored_material else None,
        "debug_material_output": debug_material_output or None,
    }
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(stats, handle, indent=2)
        handle.write("\n")

if mesh:
    evaluated.to_mesh_clear()

print(f"BLENDER_REFERENCE_OK -> {out_path}")
