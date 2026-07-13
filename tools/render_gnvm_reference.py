"""Render a GN-VM tri-soup JSON with the Chrome Assets reference camera.

Usage:
  blender --background --python tools/render_gnvm_reference.py -- SOUP.json OUT.png
"""
import json
import sys

import bpy
from mathutils import Vector


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) < 2:
    raise SystemExit("usage: SOUP.json OUT.png")
soup_path, out_path = args[:2]
with open(soup_path, "r", encoding="utf-8") as handle:
    soup = json.load(handle)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

raw = soup.get("positions", [])
vertices = [tuple(raw[index : index + 3]) for index in range(0, len(raw), 3)]
indices = soup.get("indices", [])
faces = [tuple(indices[index : index + 3]) for index in range(0, len(indices), 3)]
mesh = bpy.data.meshes.new("GNVM reference")
mesh.from_pydata(vertices, [], faces)
mesh.update()
obj = bpy.data.objects.new("GNVM reference", mesh)
bpy.context.scene.collection.objects.link(obj)

source = soup.get("object") or {}
obj.location = source.get("location") or (0, 0, 0)
obj.rotation_euler = source.get("rotation") or (0, 0, 0)
obj.scale = source.get("scale") or (1, 1, 1)
bpy.context.view_layer.update()

corners = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
if not corners:
    corners = [Vector((0, 0, 0))]
minimum = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
maximum = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
center = (minimum + maximum) * 0.5
size = maximum - minimum
radius = max(size.length * 0.5, 0.5)

camera_data = bpy.data.cameras.new("GNVM reference camera")
camera = bpy.data.objects.new("GNVM reference camera", camera_data)
bpy.context.scene.collection.objects.link(camera)
direction = Vector((1.0, -1.25, 0.85)).normalized()
camera.location = center + direction * radius * 3.0
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = max(size.x, size.y, size.z, 1.0) * 1.45

scene = bpy.context.scene
scene.camera = camera
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

print(f"GNVM_REFERENCE_OK -> {out_path}")
