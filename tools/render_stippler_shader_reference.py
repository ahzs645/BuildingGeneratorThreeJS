"""Render Image Pixel Stippler with its authored Blender material.

Usage:
  blender --background "NO3D Chrome Asset Library.blend" \
    --python tools/render_stippler_shader_reference.py -- OUT.png OUT.json

The isolated square orthographic view intentionally matches the gallery camera
direction and framing constants. Unlike ``render_blender_reference.py``, this
uses Eevee and the source material graph rather than Workbench shading.
"""
import json
import os
import sys

import bpy
from mathutils import Vector


OBJECT_NAME = "IMG PIXEL STIPPLER"
MATERIAL_NAME = "img stippler shader.001"
CAMERA_DIRECTION = Vector((1.0, -1.25, 0.85)).normalized()
FRAME_SCALE = 1.45
RESOLUTION = 768
SOURCE_PROJECT = "Node Dojo 2/Blender Tutorial/Utilities/All_N03D_Tools_Asset_Libraries/NO3D Chrome Asset Library.blend"


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 2:
    raise RuntimeError("expected OUT.png OUT.json")
out_path, meta_path = map(os.path.abspath, args[:2])

obj = bpy.data.objects.get(OBJECT_NAME)
material = bpy.data.materials.get(MATERIAL_NAME)
if obj is None:
    raise RuntimeError(f'object not found: "{OBJECT_NAME}"')
if material is None or material.node_tree is None:
    raise RuntimeError(f'authored material not found: "{MATERIAL_NAME}"')

scene = bpy.data.scenes.new("__STIPPLER_SHADER_REFERENCE_SCENE")
scene.collection.objects.link(obj)
bpy.context.window.scene = scene
obj.hide_render = False
obj.hide_viewport = False
obj.hide_set(False)

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
if mesh is None or not mesh.polygons:
    raise RuntimeError("Image Pixel Stippler produced no evaluated surface")
mesh_verts = len(mesh.vertices)
mesh_faces = len(mesh.polygons)

corners = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
minimum = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
maximum = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
center = (minimum + maximum) * 0.5
size = maximum - minimum
radius = max(size.length * 0.5, 0.5)

camera_data = bpy.data.cameras.new("__STIPPLER_SHADER_REFERENCE_CAMERA")
camera = bpy.data.objects.new("__STIPPLER_SHADER_REFERENCE_CAMERA", camera_data)
scene.collection.objects.link(camera)
camera.location = center + CAMERA_DIRECTION * radius * 3.0
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = max(size.x, size.y, size.z, 1e-4) * FRAME_SCALE
scene.camera = camera

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = RESOLUTION
scene.render.resolution_y = RESOLUTION
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = True
scene.render.filepath = out_path
scene.render.image_settings.color_depth = "8"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "Medium High Contrast"
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0
bpy.ops.render.render(write_still=True)

# Reload the written PNG so statistics describe the color-managed deliverable.
# Blender's background Render Result can expose an empty view layer here even
# though the compositor has written a valid image.
render = bpy.data.images.load(out_path, check_existing=False)
pixels = list(render.pixels)
opaque = 0
black = 0
white = 0
gray = 0
lum_sum = 0.0
for offset in range(0, len(pixels), 4):
    red, green, blue, alpha = pixels[offset:offset + 4]
    if alpha <= 0.5:
        continue
    opaque += 1
    luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    lum_sum += luminance
    if luminance < 0.1:
        black += 1
    elif luminance > 0.9:
        white += 1
    else:
        gray += 1

nodes = material.node_tree.nodes
mapping = nodes.get("Mapping.001")
map_range = nodes.get("Map Range.001")
voronoi = nodes.get("Voronoi Texture")
math_nodes = [nodes.get("Math"), nodes.get("Math.001")]
metadata = {
    "source_file": os.path.basename(bpy.data.filepath),
    "source_project": SOURCE_PROJECT,
    "object": OBJECT_NAME,
    "material": MATERIAL_NAME,
    "engine": scene.render.engine,
    "resolution": [RESOLUTION, RESOLUTION],
    "camera": {
        "type": camera_data.type,
        "direction": list(CAMERA_DIRECTION),
        "ortho_scale": camera_data.ortho_scale,
        "frame_scale": FRAME_SCALE,
    },
    "geometry": {
        "verts": mesh_verts,
        "faces": mesh_faces,
        "bbox": {"min": list(minimum), "max": list(maximum)},
    },
    "shader": {
        "mapping_rotation": list(mapping.inputs["Rotation"].default_value),
        "mapping_scale": list(mapping.inputs["Scale"].default_value),
        "map_to_min": map_range.inputs["To Min"].default_value,
        "map_to_max": map_range.inputs["To Max"].default_value,
        "map_clamp": map_range.clamp,
        "voronoi_dimensions": voronoi.voronoi_dimensions,
        "voronoi_distance": voronoi.distance,
        "voronoi_feature": voronoi.feature,
        "voronoi_normalize": voronoi.normalize,
        "math_operations": [node.operation for node in math_nodes],
    },
    "mask": {
        "opaque_pixels": opaque,
        "black_pixels": black,
        "white_pixels": white,
        "gray_pixels": gray,
        "black_fraction": black / opaque if opaque else None,
        "white_fraction": white / opaque if opaque else None,
        "gray_fraction": gray / opaque if opaque else None,
        "mean_luminance": lum_sum / opaque if opaque else None,
    },
}
with open(meta_path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, indent=2)

evaluated.to_mesh_clear()
print(f"STIPPLER_SHADER_REFERENCE_OK {out_path} {json.dumps(metadata['mask'], sort_keys=True)}")
