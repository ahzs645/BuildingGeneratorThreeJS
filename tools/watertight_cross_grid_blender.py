"""Cross-check the Watertight Bolt repeat grid with Blender's native nodes/OpenVDB.

Run through Blender's bundled Python:

  blender --background --python tools/watertight_cross_grid_blender.py -- \
    sample PASS1_MESH.json GRID_META.json OUT.f32 OUT.json

  blender --background --python tools/watertight_cross_grid_blender.py -- \
    mesh GRID.f32 GRID_META.json RUNS OUT.json

  blender SOURCE.blend --background \
    --python tools/watertight_cross_grid_blender.py -- \
    export OBJECT OUT.json.gz

``sample`` evaluates Blender's Geometry Proximity + Raycast signed-distance
field on an exact frozen lattice. ``mesh`` feeds a frozen dense FloatGrid to
Blender's bundled OpenVDB VolumeToMesh binding repeatedly without involving the
source asset graph. ``export`` forces the live hole-patch repeat to one pass and
freezes Blender's evaluated source mesh.
"""

from __future__ import annotations

from array import array
import gzip
import hashlib
import json
from pathlib import Path
import sys
import time

import bpy
import numpy as np
import openvdb


def fnv1a64(data: bytes) -> str:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def read_json(path: str) -> dict:
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: str, payload: dict) -> None:
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def read_bytes(path: str) -> bytes:
    return gzip.decompress(Path(path).read_bytes()) if path.endswith(".gz") else Path(path).read_bytes()


def write_bytes(path: str, payload: bytes) -> None:
    Path(path).write_bytes(
        gzip.compress(payload, compresslevel=9, mtime=0) if path.endswith(".gz") else payload
    )


def input_socket(node, name: str):
    result = node.inputs.get(name)
    if result is None:
        raise KeyError(f"input socket not found: {node.name}.{name}")
    return result


def output_socket(node, name: str):
    result = node.outputs.get(name)
    if result is None:
        raise KeyError(f"output socket not found: {node.name}.{name}")
    return result


def make_mesh_object(name: str, positions, faces) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(positions, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def export_pass_one(object_name: str, output_path: str) -> None:
    tree = bpy.data.node_groups.get("hole patch")
    if tree is None:
        raise KeyError("node group not found: hole patch")
    repeat_input = tree.nodes.get("Repeat Input")
    if repeat_input is None:
        raise KeyError("node not found: hole patch.Repeat Input")
    input_socket(repeat_input, "Iterations").default_value = 1
    obj = bpy.data.objects.get(object_name)
    if obj is None:
        raise KeyError(f"object not found: {object_name}")

    bpy.context.view_layer.update()
    started = time.perf_counter()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    evaluated_mesh = evaluated.to_mesh()
    try:
        positions = [
            [float(vertex.co.x), float(vertex.co.y), float(vertex.co.z)]
            for vertex in evaluated_mesh.vertices
        ]
        faces = [
            list(polygon.vertices)
            for polygon in evaluated_mesh.polygons
        ]
    finally:
        evaluated.to_mesh_clear()
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    write_json(
        output_path,
        {
            "source": {
                "blend": bpy.data.filepath,
                "object": object_name,
                "repeatGroup": "hole patch",
                "repeatNode": "Repeat Input",
                "repeatIterations": 1,
            },
            "elapsedMs": elapsed_ms,
            "blenderVersion": bpy.app.version_string,
            "verts": len(positions),
            "facesCount": len(faces),
            "positions": positions,
            "faces": faces,
        },
    )
    print(
        f"WATERTIGHT_CROSS_GRID_EXPORT_OK: "
        f"{len(positions)} verts / {len(faces)} faces -> {output_path}"
    )


def sample_field(
    mesh_path: str,
    metadata_path: str,
    binary_path: str,
    summary_path: str,
) -> None:
    frozen = read_json(mesh_path)
    metadata = read_json(metadata_path)
    target = make_mesh_object(
        "FrozenPassOne",
        frozen["positions"],
        frozen["faces"],
    )

    resolution = [int(value) for value in metadata["resolution"]]
    origin = [float(value) for value in metadata["origin"]]
    spacing = [float(value) for value in metadata["spacing"]]
    count = resolution[0] * resolution[1] * resolution[2]
    positions = [
        (
            origin[0] + x * spacing[0],
            origin[1] + y * spacing[1],
            origin[2] + z * spacing[2],
        )
        for z in range(resolution[2])
        for y in range(resolution[1])
        for x in range(resolution[0])
    ]
    samples = make_mesh_object("SdfSamples", positions, [])

    tree = bpy.data.node_groups.new("WatertightCrossGridSample", "GeometryNodeTree")
    tree.interface.new_socket(
        name="Geometry",
        in_out="INPUT",
        socket_type="NodeSocketGeometry",
    )
    tree.interface.new_socket(
        name="Geometry",
        in_out="OUTPUT",
        socket_type="NodeSocketGeometry",
    )
    group_input = tree.nodes.new("NodeGroupInput")
    group_output = tree.nodes.new("NodeGroupOutput")

    object_info = tree.nodes.new("GeometryNodeObjectInfo")
    object_info.transform_space = "ORIGINAL"
    input_socket(object_info, "Object").default_value = target

    position = tree.nodes.new("GeometryNodeInputPosition")
    proximity = tree.nodes.new("GeometryNodeProximity")
    proximity.target_element = "FACES"
    raycast = tree.nodes.new("GeometryNodeRaycast")
    raycast.data_type = "FLOAT"
    dot = tree.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    sign = tree.nodes.new("GeometryNodeSwitch")
    sign.input_type = "FLOAT"
    input_socket(sign, "False").default_value = 1.0
    input_socket(sign, "True").default_value = -1.0
    multiply = tree.nodes.new("ShaderNodeMath")
    multiply.operation = "MULTIPLY"
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT"
    store.domain = "POINT"
    input_socket(store, "Name").default_value = "__watertight_sdf"

    tree.links.new(output_socket(object_info, "Geometry"), input_socket(proximity, "Target"))
    tree.links.new(output_socket(object_info, "Geometry"), input_socket(raycast, "Target Geometry"))
    tree.links.new(output_socket(position, "Position"), input_socket(raycast, "Ray Direction"))
    tree.links.new(output_socket(position, "Position"), input_socket(dot, "Vector"))
    tree.links.new(output_socket(raycast, "Hit Normal"), input_socket(dot, "Vector_001"))
    tree.links.new(output_socket(dot, "Value"), input_socket(sign, "Switch"))
    tree.links.new(output_socket(proximity, "Distance"), input_socket(multiply, "Value"))
    tree.links.new(output_socket(sign, "Output"), input_socket(multiply, "Value_001"))
    tree.links.new(output_socket(group_input, "Geometry"), input_socket(store, "Geometry"))
    tree.links.new(output_socket(multiply, "Value"), input_socket(store, "Value"))
    tree.links.new(output_socket(store, "Geometry"), input_socket(group_output, "Geometry"))

    modifier = samples.modifiers.new("WatertightCrossGridSample", "NODES")
    modifier.node_group = tree
    bpy.context.view_layer.objects.active = samples
    samples.select_set(True)
    bpy.context.view_layer.update()

    started = time.perf_counter()
    evaluated = samples.evaluated_get(bpy.context.evaluated_depsgraph_get())
    evaluated_mesh = evaluated.to_mesh()
    try:
        attribute = evaluated_mesh.attributes["__watertight_sdf"]
        values = array("f", (float(item.value) for item in attribute.data))
    finally:
        evaluated.to_mesh_clear()
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    if len(values) != count:
        raise RuntimeError(f"expected {count} samples, received {len(values)}")
    raw = values.tobytes()
    write_bytes(binary_path, raw)
    write_json(
        summary_path,
        {
            "mode": "sample",
            "sourceMesh": mesh_path,
            "sourceMetadata": metadata_path,
            "resolution": resolution,
            "origin": origin,
            "spacing": spacing,
            "background": float(metadata["background"]),
            "valueCount": len(values),
            "fnv1a64": fnv1a64(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "minimum": min(values),
            "maximum": max(values),
            "negative": sum(value < 0 for value in values),
            "zero": sum(value == 0 for value in values),
            "elapsedMs": elapsed_ms,
            "blenderVersion": bpy.app.version_string,
            "openvdbVersion": openvdb.LIBRARY_VERSION,
        },
    )
    print(f"WATERTIGHT_CROSS_GRID_SAMPLE_OK: {len(values)} values -> {binary_path}")


def mesh_grid(
    binary_path: str,
    metadata_path: str,
    runs: int,
    summary_path: str,
) -> None:
    metadata = read_json(metadata_path)
    resolution = tuple(int(value) for value in metadata["resolution"])
    origin = tuple(float(value) for value in metadata["origin"])
    spacing = tuple(float(value) for value in metadata["spacing"])
    values = np.frombuffer(read_bytes(binary_path), dtype="<f4")
    expected = resolution[0] * resolution[1] * resolution[2]
    if values.size != expected:
        raise RuntimeError(f"expected {expected} samples, received {values.size}")
    # GN-VM's binary is X-major. PyOpenVDB's NumPy contract indexes [x, y, z].
    # copyFromArray consumes an [x, y, z] C-contiguous buffer. The transpose
    # alone is only a strided view and is misread by Blender's OpenVDB binding.
    dense = np.ascontiguousarray(
        values.reshape((resolution[2], resolution[1], resolution[0])).transpose((2, 1, 0))
    )
    isolation = float(metadata.get("isolation", 0.0))
    source_background = float(metadata["background"])
    # A frozen GN-VM dense grid uses zero-filled padding to mean "outside".
    # Feeding an inactive OpenVDB background equal to the zero isosurface makes
    # convertToPolygons contour the active tile boundary as well as the field.
    # Reconstruct the equivalent SDF exterior with a positive background and
    # map only exact source-background samples (the padding) to that exterior.
    positive_values = values[values > isolation]
    exterior = float(positive_values.max()) if positive_values.size else isolation + 1.0
    if not exterior > isolation:
        exterior = isolation + 1.0
    openvdb_dense = np.ascontiguousarray(
        np.where(dense == source_background, exterior, dense)
    )
    matrix = [
        [spacing[0], 0.0, 0.0, 0.0],
        [0.0, spacing[1], 0.0, 0.0],
        [0.0, 0.0, spacing[2], 0.0],
        [origin[0], origin[1], origin[2], 1.0],
    ]
    results = []
    for index in range(runs):
        grid = openvdb.FloatGrid(exterior)
        grid.copyFromArray(openvdb_dense, tolerance=0.0)
        grid.transform = openvdb.createLinearTransform(matrix)
        started = time.perf_counter()
        points, triangles, quads = grid.convertToPolygons(
            isovalue=isolation,
            adaptivity=0.0,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        topology = (
            np.asarray(points, dtype="<f4").tobytes()
            + np.asarray(triangles, dtype="<u4").tobytes()
            + np.asarray(quads, dtype="<u4").tobytes()
        )
        result = {
            "run": index + 1,
            "verts": int(points.shape[0]),
            "triangles": int(triangles.shape[0]),
            "quads": int(quads.shape[0]),
            "faces": int(triangles.shape[0] + quads.shape[0]),
            "elapsedMs": elapsed_ms,
            "topologySha256": hashlib.sha256(topology).hexdigest(),
            "activeVoxels": int(grid.activeVoxelCount()),
            "openvdbBackground": exterior,
        }
        results.append(result)
        print(json.dumps(result, separators=(",", ":")))
    write_json(
        summary_path,
        {
            "mode": "mesh",
            "sourceGrid": binary_path,
            "sourceMetadata": metadata_path,
            "resolution": resolution,
            "origin": origin,
            "spacing": spacing,
            "background": float(metadata["background"]),
            "openvdbBackground": exterior,
            "valueCount": int(values.size),
            "fnv1a64": fnv1a64(values.tobytes()),
            "sha256": hashlib.sha256(values.tobytes()).hexdigest(),
            "blenderVersion": bpy.app.version_string,
            "openvdbVersion": openvdb.LIBRARY_VERSION,
            "runs": results,
        },
    )
    print(f"WATERTIGHT_CROSS_GRID_MESH_OK: {runs} runs -> {summary_path}")


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :]
    if not args:
        raise SystemExit("expected sample or mesh subcommand")
    if args[0] == "sample" and len(args) == 5:
        sample_field(*args[1:])
    elif args[0] == "mesh" and len(args) == 5:
        mesh_grid(args[1], args[2], int(args[3]), args[4])
    elif args[0] == "export" and len(args) == 3:
        export_pass_one(args[1], args[2])
    else:
        raise SystemExit(
            "usage: sample PASS1_MESH GRID_META OUT.f32 OUT.json "
            "| mesh GRID.f32 GRID_META RUNS OUT.json "
            "| export OBJECT OUT.json[.gz]"
        )


main()
