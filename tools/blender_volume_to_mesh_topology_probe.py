"""Measure Blender's polygon topology for a minimal Volume Cube to Mesh graph."""
import json
import sys

import bpy


out_path = sys.argv[sys.argv.index("--") + 1]
mesh = bpy.data.meshes.new("volume probe seed")
mesh.from_pydata([(0, 0, 0)], [], [])
obj = bpy.data.objects.new("volume probe", mesh)
bpy.context.scene.collection.objects.link(obj)

tree = bpy.data.node_groups.new("volume topology probe", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
tree.nodes.new("NodeGroupInput")
output = tree.nodes.new("NodeGroupOutput")
position = tree.nodes.new("GeometryNodeInputPosition")
length = tree.nodes.new("ShaderNodeVectorMath")
length.operation = "LENGTH"
subtract = tree.nodes.new("ShaderNodeMath")
subtract.operation = "SUBTRACT"
subtract.inputs[1].default_value = 0.7
volume = tree.nodes.new("GeometryNodeVolumeCube")
volume.inputs["Min"].default_value = (-1, -1, -1)
volume.inputs["Max"].default_value = (1, 1, 1)
volume.inputs["Resolution X"].default_value = 16
volume.inputs["Resolution Y"].default_value = 16
volume.inputs["Resolution Z"].default_value = 16
to_mesh = tree.nodes.new("GeometryNodeVolumeToMesh")
to_mesh.inputs["Threshold"].default_value = 0
tree.links.new(position.outputs["Position"], length.inputs[0])
tree.links.new(length.outputs["Value"], subtract.inputs[0])
tree.links.new(subtract.outputs[0], volume.inputs["Density"])
tree.links.new(volume.outputs["Volume"], to_mesh.inputs["Volume"])
tree.links.new(to_mesh.outputs["Mesh"], output.inputs["Geometry"])
modifier = obj.modifiers.new("GeometryNodes", "NODES")
modifier.node_group = tree

bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
try:
    face_sizes = {}
    for polygon in result.polygons:
        face_sizes[str(len(polygon.vertices))] = face_sizes.get(str(len(polygon.vertices)), 0) + 1
    positions = [list(vertex.co) for vertex in result.vertices]
    payload = {
        "verts": len(result.vertices),
        "faces": len(result.polygons),
        "face_sizes": face_sizes,
        "bbox": {
            "min": [min(position[axis] for position in positions) for axis in range(3)],
            "max": [max(position[axis] for position in positions) for axis in range(3)],
        },
    }
finally:
    evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_VOLUME_TO_MESH_TOPOLOGY_OK {json.dumps(payload)} -> {out_path}")
