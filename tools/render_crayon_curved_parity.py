"""Render the deterministic Chrome Crayon surface-wrap parity case.

The original node group generates a planar mesh. This script applies the same
arc-length frame wrap as /surface-draw, then places it over the same wobbled
sphere so the browser-added projection stage can be tested independently.
"""
import json
import math
import sys

import bpy
from mathutils import Matrix, Vector


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, meta_path = args[:3]


def curved_samples():
    center = Vector((0.55, -0.7, 0.46)).normalized()
    u = Vector((0.0, 0.0, 1.0)).cross(center).normalized()
    v = center.cross(u).normalized()
    samples = []
    for index in range(41):
        t = -1.0 + index / 20.0
        cross = 0.22 * math.sin(t * math.pi * 1.4) + 0.08 * math.cos(t * math.pi * 2.6)
        normal = (center + u * (t * 0.75) + v * cross).normalized()
        base = normal * 3.0
        wobble = 1.0 + 0.075 * math.sin(base.z * 2.4) * math.cos(math.atan2(base.y, base.x) * 5.0)
        samples.append((base * wobble, normal))
    return samples


samples = curved_samples()
distances = [0.0]
for index in range(1, len(samples)):
    distances.append(distances[-1] + (samples[index][0] - samples[index - 1][0]).length)


def frame_at(distance):
    remaining = max(0.0, min(distance, distances[-1]))
    index = 0
    while index < len(samples) - 2 and remaining > distances[index + 1]:
        index += 1
    segment_start = distances[index]
    segment_length = max(distances[index + 1] - segment_start, 1e-9)
    factor = max(0.0, min((remaining - segment_start) / segment_length, 1.0))
    point = samples[index][0].lerp(samples[index + 1][0], factor)
    tangent = (samples[index + 1][0] - samples[index][0]).normalized()
    normal = samples[index][1].lerp(samples[index + 1][1], factor).normalized()
    lateral = normal.cross(tangent).normalized()
    if lateral.length_squared < 1e-9:
        lateral = Vector((0.0, 1.0, 0.0))
    return point, tangent, lateral, normal


source = bpy.data.objects[object_name]
source.matrix_world = Matrix.Identity(4)
source.data.splines.clear()
spline = source.data.splines.new("POLY")
spline.points.add(len(samples) - 1)
for point, distance in zip(spline.points, distances):
    point.co = (distance * 20.0, 0.0, 0.0, 1.0)
spline.use_cyclic_u = False

modifier = next(item for item in source.modifiers if item.type == "NODES" and item.node_group)
identifiers = {
    item.name: item.identifier
    for item in modifier.node_group.interface.items_tree
    if item.item_type == "SOCKET" and item.in_out == "INPUT"
}
for name, value in {
    "Line Thiccness": 6.0,
    "Peak Height": 10.0,
    "Sigilize": 0,
    "Soften": 0,
    "resolution": 0.8,
    "SPIRO": 1,
    "Extrude Base": 1.0,
    "FLATTEN": False,
}.items():
    modifier[identifiers[name]] = value
source.update_tag()
bpy.context.view_layer.update()

depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = source.evaluated_get(depsgraph)
mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
for vertex in mesh.vertices:
    point, _tangent, lateral, normal = frame_at(vertex.co.x / 20.0)
    vertex.co = point + lateral * (vertex.co.y / 20.0) + normal * (vertex.co.z / 20.0)
mesh.update()

scene = bpy.data.scenes.new("__CRAYON_CURVED_PARITY")
bpy.context.window.scene = scene
brush = bpy.data.objects.new("Browser wrap parity", mesh)
scene.collection.objects.link(brush)
brush_material = bpy.data.materials.new("Chrome Crayon")
brush_material.diffuse_color = (0.72, 0.82, 0.78, 1.0)
brush.data.materials.append(brush_material)

bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=3.0)
target = bpy.context.object
target.name = "Wobbled browser target"
for vertex in target.data.vertices:
    point = vertex.co.copy()
    wobble = 1.0 + 0.075 * math.sin(point.z * 2.4) * math.cos(math.atan2(point.y, point.x) * 5.0)
    vertex.co *= wobble
target.data.update()
target_material = bpy.data.materials.new("Target")
target_material.diffuse_color = (0.20, 0.29, 0.24, 1.0)
target.data.materials.append(target_material)

camera_data = bpy.data.cameras.new("Parity camera")
camera = bpy.data.objects.new("Parity camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (6.7, -8.5, 5.6)
forward = (Vector((0.0, 0.0, 0.0)) - camera.location).normalized()
right = forward.cross(Vector((0.0, 1.0, 0.0))).normalized()
camera_up = right.cross(forward).normalized()
camera.rotation_euler = Matrix((right, camera_up, -forward)).transposed().to_euler()
camera_data.type = "PERSP"
camera_data.angle = math.radians(40.0)
scene.camera = camera

scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.display.shading.cavity_type = "BOTH"
scene.display.shading.show_specular_highlight = True
scene.display.shading.background_type = "VIEWPORT"
scene.display.shading.background_color = (0.025, 0.035, 0.03)
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.render.filepath = out_path
scene.view_settings.look = "AgX - Medium High Contrast"
bpy.ops.render.render(write_still=True)

positions = [list(vertex.co) for vertex in mesh.vertices]
minimum = [min(point[axis] for point in positions) for axis in range(3)]
maximum = [max(point[axis] for point in positions) for axis in range(3)]
with open(meta_path, "w", encoding="utf-8") as handle:
    json.dump({
        "object": brush.name,
        "verts": len(mesh.vertices),
        "faces": len(mesh.polygons),
        "bbox": {"min": minimum, "max": maximum},
        "positions": positions,
        "faces_data": [list(face.vertices) for face in mesh.polygons],
    }, handle)
print(f"CRAYON_CURVED_PARITY_OK -> {out_path}")
