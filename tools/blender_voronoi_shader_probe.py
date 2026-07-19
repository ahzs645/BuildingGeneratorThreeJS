"""Render exact scalar probes for the Nodes Node Noodle Pair Voronoi graph.

Usage:
  blender --background --python tools/blender_voronoi_shader_probe.py -- \
    '[[0.125,0.5,0.125],[0.5,0.5,0.5]]' /tmp/voronoi.json

The input points are Generated coordinates. Each point is passed through the
authored Mapping and 3D Smooth F1 Voronoi nodes, then emitted as a linear
grayscale value so Blender's shader evaluator is the oracle.
"""

import json
import glob
import os
import sys

import bpy
import OpenImageIO as oiio


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 2:
    raise SystemExit("expected POINTS_JSON OUT_JSON")
points = json.loads(args[0])
output_path = args[1]

scene = bpy.context.scene
for existing in list(bpy.data.objects):
    bpy.data.objects.remove(existing, do_unlink=True)
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
scene.render.resolution_x = 4
scene.render.resolution_y = 4
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"
scene.view_settings.look = "None"
scene.view_settings.view_transform = "Standard"
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0
scene.world.color = (0.0, 0.0, 0.0)

camera_data = bpy.data.cameras.new("Voronoi probe camera")
camera_data.type = "ORTHO"
camera_data.ortho_scale = 2.0
camera = bpy.data.objects.new("Voronoi probe camera", camera_data)
scene.collection.objects.link(camera)
camera.location = (0.0, 0.0, 2.0)
scene.camera = camera

mesh = bpy.data.meshes.new("Voronoi probe plane")
mesh.from_pydata([(-2.0, -2.0, 0.0), (2.0, -2.0, 0.0), (2.0, 2.0, 0.0), (-2.0, 2.0, 0.0)], [], [(0, 1, 2, 3)])
plane = bpy.data.objects.new("Voronoi probe plane", mesh)
scene.collection.objects.link(plane)

material = bpy.data.materials.new("Voronoi probe material")
material.use_nodes = True
nodes = material.node_tree.nodes
nodes.clear()
output = nodes.new("ShaderNodeOutputMaterial")
aov_output = nodes.new("ShaderNodeOutputAOV")
aov_output.aov_name = "Voronoi"
aov = scene.view_layers[0].aovs.add()
aov.name = "Voronoi"
aov.type = "VALUE"
emission = nodes.new("ShaderNodeEmission")
mapping = nodes.new("ShaderNodeMapping")
mapping.vector_type = "POINT"
mapping.inputs["Location"].default_value = (0.0, 0.0, 0.0)
mapping.inputs["Rotation"].default_value = (1.5707963705062866, 0.7853981852531433, 0.0)
mapping.inputs["Scale"].default_value = (1.0, 1.0, 1.440000057220459)
voronoi = nodes.new("ShaderNodeTexVoronoi")
voronoi.voronoi_dimensions = "3D"
voronoi.distance = "EUCLIDEAN"
voronoi.feature = "SMOOTH_F1"
voronoi.normalize = False
voronoi.inputs["Scale"].default_value = 791.2999267578125
voronoi.inputs["Detail"].default_value = 0.0
voronoi.inputs["Smoothness"].default_value = 1.0
voronoi.inputs["Randomness"].default_value = 0.7094972133636475
material.node_tree.links.new(mapping.outputs["Vector"], voronoi.inputs["Vector"])
material.node_tree.links.new(voronoi.outputs["Distance"], aov_output.inputs["Value"])
emission.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
material.node_tree.links.new(voronoi.outputs["Distance"], emission.inputs["Strength"])
material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
plane.data.materials.append(material)

scene.use_nodes = True
compositor = bpy.data.node_groups.new("Voronoi probe compositor", "CompositorNodeTree")
scene.compositing_node_group = compositor
compositor.nodes.clear()
render_layers = compositor.nodes.new("CompositorNodeRLayers")
file_output = compositor.nodes.new("CompositorNodeOutputFile")
file_output.format.file_format = "OPEN_EXR_MULTILAYER"
file_output.file_output_items.new("FLOAT", "Voronoi")
compositor.links.new(render_layers.outputs["Voronoi"], file_output.inputs["Voronoi"])

values = []
channels = []
for index, point in enumerate(points):
    mapping.inputs["Vector"].default_value = point
    material.update_tag()
    bpy.context.view_layer.update()
    render_path = f"{output_path}.{index}.exr"
    scene.render.filepath = render_path
    aov_prefix = f"{os.path.basename(output_path)}.aov.{index}"
    file_output.file_name = aov_prefix
    bpy.ops.render.render(write_still=True)
    aov_path = glob.glob(os.path.join("/tmp", f"{aov_prefix}*.exr"))[0]
    image = oiio.ImageInput.open(aov_path)
    spec = image.spec()
    channel_names = list(spec.channelnames)
    pixels = image.read_image()
    values.append(float(pixels[spec.height // 2, spec.width // 2, 0]))
    channels.append(channel_names[0])
    image.close()
    os.remove(render_path)
    os.remove(aov_path)

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump({"blenderVersion": bpy.app.version_string, "points": points, "values": values, "channels": channels}, handle, indent=2)
    handle.write("\n")
