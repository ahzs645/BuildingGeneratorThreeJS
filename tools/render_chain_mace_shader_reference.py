"""Render Chain & Mace with its authored Eevee materials.

Usage:
  blender --background "NO3D Chrome Asset Library.blend" \
    --python tools/render_chain_mace_shader_reference.py -- OUT.png OUT.json

The isolated square orthographic capture uses the same camera direction and
1.45 framing scale as the browser Chrome Assets viewer. Unlike the older
Workbench catalog thumbnail, this render evaluates the realized mesh's actual
``chrome.002`` assignment across both the baked mace and chain.
"""
import json
import os
import sys

import bpy
from mathutils import Vector


OBJECT_NAME = "spikey chain and mace.005"
CAMERA_DIRECTION = Vector((1.0, -1.25, 0.85)).normalized()
FRAME_SCALE = 1.45
RESOLUTION = 768
SOURCE_PROJECT = "Node Dojo 2/Blender Tutorial/Utilities/All_N03D_Tools_Asset_Libraries/NO3D Chrome Asset Library.blend"


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 2:
    raise RuntimeError("expected OUT.png OUT.json")
out_path, meta_path = map(os.path.abspath, args[:2])

obj = bpy.data.objects.get(OBJECT_NAME)
if obj is None:
    raise RuntimeError(f'object not found: "{OBJECT_NAME}"')
for name in ("chrome.002", "grainy test"):
    material = bpy.data.materials.get(name)
    if material is None or material.node_tree is None:
        raise RuntimeError(f'authored material not found: "{name}"')

scene = bpy.data.scenes.new("__CHAIN_MACE_SHADER_REFERENCE_SCENE")
scene.collection.objects.link(obj)
bpy.context.window.scene = scene
obj.hide_render = False
obj.hide_viewport = False
obj.hide_set(False)

# The source output retains an instanced component. Realize it only for this
# isolated render so material slots and topology describe the visible result.
realize_group = bpy.data.node_groups.new("__CHAIN_MACE_REFERENCE_REALIZE", "GeometryNodeTree")
realize_group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
realize_group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
realize_input = realize_group.nodes.new("NodeGroupInput")
realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
realize_output = realize_group.nodes.new("NodeGroupOutput")
realize_group.links.new(realize_input.outputs["Geometry"], realize.inputs["Geometry"])
realize_group.links.new(realize.outputs["Geometry"], realize_output.inputs["Geometry"])
realize_modifier = obj.modifiers.new(name="__CHAIN_MACE_REFERENCE_REALIZE", type="NODES")
realize_modifier.node_group = realize_group

world = bpy.data.worlds.new("__CHAIN_MACE_SHADER_REFERENCE_WORLD")
world.use_nodes = True
environment = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
studio_path = os.path.join(bpy.utils.resource_path("LOCAL"), "datafiles", "studiolights", "world", "studio.exr")
environment.image = bpy.data.images.load(studio_path, check_existing=True)
world.node_tree.links.new(environment.outputs["Color"], world.node_tree.nodes["Background"].inputs["Color"])
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
scene.world = world

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
if mesh is None or not mesh.polygons:
    raise RuntimeError("Chain & Mace produced no evaluated surface")

points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
minimum = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
maximum = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
center = (minimum + maximum) * 0.5
size = maximum - minimum
radius = max(size.length * 0.5, 0.5)

camera_data = bpy.data.cameras.new("__CHAIN_MACE_SHADER_REFERENCE_CAMERA")
camera = bpy.data.objects.new("__CHAIN_MACE_SHADER_REFERENCE_CAMERA", camera_data)
scene.collection.objects.link(camera)
camera.location = center + CAMERA_DIRECTION * radius * 3.0
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = max(size.x, size.y, size.z, 1e-4) * FRAME_SCALE
scene.camera = camera

key_data = bpy.data.lights.new("__CHAIN_MACE_KEY", "AREA")
key_data.energy = 1250.0
key_data.shape = "DISK"
key_data.size = radius * 1.5
key = bpy.data.objects.new("__CHAIN_MACE_KEY", key_data)
scene.collection.objects.link(key)
key.location = center + Vector((-1.8, -2.1, 2.8)).normalized() * radius * 2.4
key.rotation_euler = (center - key.location).to_track_quat("-Z", "Y").to_euler()

fill_data = bpy.data.lights.new("__CHAIN_MACE_FILL", "AREA")
fill_data.energy = 650.0
fill_data.size = radius * 2.0
fill = bpy.data.objects.new("__CHAIN_MACE_FILL", fill_data)
scene.collection.objects.link(fill)
fill.location = center + Vector((2.0, 1.0, 1.0)).normalized() * radius * 2.0
fill.rotation_euler = (center - fill.location).to_track_quat("-Z", "Y").to_euler()

# Blender can invalidate the temporary evaluated mesh during render. Retain
# all topology/material evidence before asking Eevee to draw the frame.
mesh_verts = len(mesh.vertices)
mesh_faces = len(mesh.polygons)
material_slots = [material.name if material else None for material in mesh.materials]
geometry_attributes = [attribute.name for attribute in mesh.attributes]
attribute_stats = {}
for attribute_name in ("rough", "1"):
    attribute = mesh.attributes.get(attribute_name)
    if attribute is None:
        continue
    values = [float(item.value) for item in attribute.data]
    attribute_stats[attribute_name] = {
        "domain": attribute.domain,
        "count": len(values),
        "min": min(values) if values else None,
        "max": max(values) if values else None,
        "value_counts": {str(value): values.count(value) for value in sorted(set(values))},
    }
face_materials = {}
for polygon in mesh.polygons:
    name = material_slots[polygon.material_index] if polygon.material_index < len(material_slots) else None
    face_materials[name or "<none>"] = face_materials.get(name or "<none>", 0) + 1

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = RESOLUTION
scene.render.resolution_y = RESOLUTION
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.image_settings.color_depth = "8"
scene.render.film_transparent = True
scene.render.filepath = out_path
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "Medium High Contrast"
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0
bpy.ops.render.render(write_still=True)

metadata = {
    "source_file": os.path.basename(bpy.data.filepath),
    "source_project": SOURCE_PROJECT,
    "object": OBJECT_NAME,
    "engine": scene.render.engine,
    "resolution": [RESOLUTION, RESOLUTION],
    "camera": {"type": camera_data.type, "direction": list(CAMERA_DIRECTION), "ortho_scale": camera_data.ortho_scale, "frame_scale": FRAME_SCALE},
    "geometry": {"verts": mesh_verts, "faces": mesh_faces, "bbox": {"min": list(minimum), "max": list(maximum)}},
    "materials": {
        "source_object_slots": [slot.material.name if slot.material else None for slot in obj.material_slots],
        "evaluated_slots": material_slots,
        "faces": face_materials,
        "geometry_attributes": geometry_attributes,
        "attribute_stats": attribute_stats,
        "shader_named_attribute": "rough",
        "missing_attribute_value": 0.0,
    },
}
with open(meta_path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, indent=2)

evaluated.to_mesh_clear()
print(f"CHAIN_MACE_SHADER_REFERENCE_OK {out_path} {json.dumps(face_materials, sort_keys=True)}")
