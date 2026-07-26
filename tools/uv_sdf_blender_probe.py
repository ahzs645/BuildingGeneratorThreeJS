"""Emit canonical Blender 5.x truth for bounded UV/SDF GN nodes.

The browser runtime intentionally remains bounded, but these fixtures make the
remaining distance from Blender measurable instead of anecdotal.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --factory-startup \
    --python tools/uv_sdf_blender_probe.py
"""

import json

import bpy


def socket(node, in_out, identifier):
    sockets = node.inputs if in_out == "INPUT" else node.outputs
    for candidate in sockets:
        if candidate.identifier == identifier or candidate.name == identifier:
            return candidate
    raise RuntimeError(
        f"{node.bl_idname} has no {in_out.lower()} socket {identifier}: "
        + ", ".join(f"{item.name} ({item.identifier})" for item in sockets)
    )


def geometry_tree(name):
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    return tree, tree.nodes.new("NodeGroupInput"), tree.nodes.new("NodeGroupOutput")


def evaluate_object(name, mesh, tree):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    modifier = obj.modifiers.new(name="Probe", type="NODES")
    modifier.node_group = tree
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return evaluated, evaluated.to_mesh()


def mesh_from_data(name, vertices, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def uv_unwrap_mesh_probe(name, mesh, seam_pairs=(), method="Angle Based", margin=0.001):
    tree, group_input, group_output = geometry_tree(f"{name} Tree")
    unwrap = tree.nodes.new("GeometryNodeUVUnwrap")
    socket(unwrap, "INPUT", "Selection").default_value = True
    socket(unwrap, "INPUT", "Margin").default_value = margin
    socket(unwrap, "INPUT", "Method").default_value = method
    if seam_pairs:
        seam_keys = {tuple(sorted(pair)) for pair in seam_pairs}
        seam = mesh.attributes.new("probe_seam", "BOOLEAN", "EDGE")
        for edge, value in zip(mesh.edges, seam.data):
            value.value = tuple(sorted(edge.vertices)) in seam_keys
        named = tree.nodes.new("GeometryNodeInputNamedAttribute")
        named.data_type = "BOOLEAN"
        socket(named, "INPUT", "Name").default_value = "probe_seam"
        tree.links.new(socket(named, "OUTPUT", "Attribute"), socket(unwrap, "INPUT", "Seam"))
    else:
        socket(unwrap, "INPUT", "Seam").default_value = False
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT_VECTOR"
    store.domain = "CORNER"
    socket(store, "INPUT", "Name").default_value = "uv_probe"
    tree.links.new(
        socket(group_input, "OUTPUT", "Geometry"),
        socket(store, "INPUT", "Geometry"),
    )
    tree.links.new(socket(unwrap, "OUTPUT", "UV"), socket(store, "INPUT", "Value"))
    tree.links.new(
        socket(store, "OUTPUT", "Geometry"),
        socket(group_output, "INPUT", "Geometry"),
    )
    evaluated, result = evaluate_object(name, mesh, tree)
    try:
        attribute = result.attributes["uv_probe"]
        return {
            "domain": attribute.domain,
            "values": [
                [float(value) for value in item.vector]
                for item in attribute.data
            ],
        }
    finally:
        evaluated.to_mesh_clear()


def uv_unwrap_probe():
    return uv_unwrap_mesh_probe(
        "UV Unwrap Probe",
        mesh_from_data(
            "UV Probe Mesh",
            [
                (0, 0, 0),
                (1, 0, 0),
                (1, 1, 0),
                (0, 1, 0),
                (2, 0, 0),
                (2, 1, 0),
                (2, 1, 1),
                (2, 0, 1),
            ],
            [(0, 1, 2, 3), (4, 5, 6, 7)],
        ),
    )


def uv_seam_probes():
    strip_vertices = [
        (0, 0, 0), (1, 0, 0),
        (0, 1, 0), (1, 1, 0),
        (0, 2, 0.5), (1, 2, 0.5),
        (0, 3, 1.5), (1, 3, 1.5),
    ]
    strip_faces = [(0, 1, 3, 2), (2, 3, 5, 4), (4, 5, 7, 6)]
    cube_vertices = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    cube_faces = [
        (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    return {
        "bent_strip_no_seams": uv_unwrap_mesh_probe(
            "Bent Strip No Seams",
            mesh_from_data("Bent Strip No Seams Mesh", strip_vertices, strip_faces),
        ),
        "bent_strip_middle_seam": uv_unwrap_mesh_probe(
            "Bent Strip Middle Seam",
            mesh_from_data("Bent Strip Middle Seam Mesh", strip_vertices, strip_faces),
            seam_pairs=((2, 3),),
        ),
        "cube_seam_heavy_angle": uv_unwrap_mesh_probe(
            "Cube Seam Heavy Angle",
            mesh_from_data("Cube Seam Heavy Angle Mesh", cube_vertices, cube_faces),
            seam_pairs=((0, 1), (1, 2), (2, 3), (3, 0), (0, 4), (2, 6)),
            method="Angle Based",
        ),
        "cube_seam_heavy_conformal": uv_unwrap_mesh_probe(
            "Cube Seam Heavy Conformal",
            mesh_from_data("Cube Seam Heavy Conformal Mesh", cube_vertices, cube_faces),
            seam_pairs=((0, 1), (1, 2), (2, 3), (3, 0), (0, 4), (2, 6)),
            method="Conformal",
        ),
    }


def uv_pack_probe(margin):
    mesh = bpy.data.meshes.new("UV Pack Probe Mesh")
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    source = mesh.attributes.new("source_uv", "FLOAT_VECTOR", "CORNER")
    for item, value in zip(
        source.data,
        ((2, 4, 0), (6, 4, 0), (6, 6, 0), (2, 6, 0)),
    ):
        item.vector = value
    mesh.update()
    tree, group_input, group_output = geometry_tree("UV Pack Probe")
    named = tree.nodes.new("GeometryNodeInputNamedAttribute")
    named.data_type = "FLOAT_VECTOR"
    socket(named, "INPUT", "Name").default_value = "source_uv"
    pack = tree.nodes.new("GeometryNodeUVPackIslands")
    socket(pack, "INPUT", "Selection").default_value = True
    socket(pack, "INPUT", "Margin").default_value = margin
    socket(pack, "INPUT", "Bottom Left").default_value = (0, 0)
    socket(pack, "INPUT", "Top Right").default_value = (1, 1)
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT_VECTOR"
    store.domain = "CORNER"
    socket(store, "INPUT", "Name").default_value = "packed_uv"
    tree.links.new(socket(named, "OUTPUT", "Attribute"), socket(pack, "INPUT", "UV"))
    tree.links.new(socket(group_input, "OUTPUT", "Geometry"), socket(store, "INPUT", "Geometry"))
    tree.links.new(socket(pack, "OUTPUT", "UV"), socket(store, "INPUT", "Value"))
    tree.links.new(socket(store, "OUTPUT", "Geometry"), socket(group_output, "INPUT", "Geometry"))
    evaluated, result = evaluate_object("UV Pack Probe", mesh, tree)
    try:
        attribute = result.attributes["packed_uv"]
        return {
            "domain": attribute.domain,
            "values": [
                [float(value) for value in item.vector]
                for item in attribute.data
            ],
        }
    finally:
        evaluated.to_mesh_clear()


def cube_mesh(name, size=1.0):
    return mesh_from_data(
        name,
        [
            (0, 0, 0),
            (size, 0, 0),
            (size, size, 0),
            (0, size, 0),
            (0, 0, size),
            (size, 0, size),
            (size, size, size),
            (0, size, size),
        ],
        [
            (0, 3, 2, 1),
            (4, 5, 6, 7),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        ]
    )


def mesh_sdf_case(name, mesh, voxel_size=0.25, adaptivity=0.0, include_levels=False):
    tree, group_input, group_output = geometry_tree(f"{name} Tree")
    sdf = tree.nodes.new("GeometryNodeMeshToSDFGrid")
    socket(sdf, "INPUT", "Voxel Size").default_value = voxel_size
    socket(sdf, "INPUT", "Band Width").default_value = 3
    to_mesh = tree.nodes.new("GeometryNodeGridToMesh")
    socket(to_mesh, "INPUT", "Threshold").default_value = 0.0
    socket(to_mesh, "INPUT", "Adaptivity").default_value = adaptivity
    tree.links.new(socket(group_input, "OUTPUT", "Geometry"), socket(sdf, "INPUT", "Mesh"))
    tree.links.new(socket(sdf, "OUTPUT", "SDF Grid"), socket(to_mesh, "INPUT", "Grid"))
    tree.links.new(socket(to_mesh, "OUTPUT", "Mesh"), socket(group_output, "INPUT", "Geometry"))
    evaluated, result = evaluate_object(name, mesh, tree)
    try:
        positions = [[float(value) for value in vertex.co] for vertex in result.vertices]
        face_sizes = {}
        for polygon in result.polygons:
            key = str(len(polygon.vertices))
            face_sizes[key] = face_sizes.get(key, 0) + 1
        output = {
            "vertices": len(result.vertices),
            "edges": len(result.edges),
            "faces": len(result.polygons),
            "face_sizes": face_sizes,
            "bounds": {
                "min": [
                    min(point[axis] for point in positions)
                    for axis in range(3)
                ],
                "max": [
                    max(point[axis] for point in positions)
                    for axis in range(3)
                ],
            },
        }
        if include_levels:
            output["coordinate_levels"] = [
                sorted(set(round(point[axis], 7) for point in positions))
                for axis in range(3)
            ]
        return output
    finally:
        evaluated.to_mesh_clear()


def mesh_sdf_probe():
    return mesh_sdf_case(
        "Mesh SDF Probe",
        cube_mesh("SDF Cube"),
        include_levels=True,
    )


def non_manifold_sdf_probes():
    return {
        "open_quad": mesh_sdf_case(
            "Open Quad SDF",
            mesh_from_data(
                "Open Quad SDF Mesh",
                [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)],
                [(0, 1, 2, 3)],
            ),
        ),
        "three_face_edge": mesh_sdf_case(
            "Three Face Edge SDF",
            mesh_from_data(
                "Three Face Edge SDF Mesh",
                [
                    (0, 0, 0), (1, 0, 0), (.5, 1, 0),
                    (.5, 0, 1), (.5, -1, 0),
                ],
                [(0, 1, 2), (1, 0, 3), (0, 1, 4)],
            ),
        ),
        "cube_one_flipped_face": mesh_sdf_case(
            "Cube One Flipped Face SDF",
            mesh_from_data(
                "Cube One Flipped Face SDF Mesh",
                [
                    (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
                    (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
                ],
                [
                    (1, 2, 3, 0),  # deliberately reversed
                    (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5),
                    (2, 3, 7, 6), (3, 0, 4, 7),
                ],
            ),
        ),
    }


def adaptive_sdf_probes():
    return {
        str(adaptivity): mesh_sdf_case(
            f"Adaptive Cube {adaptivity}",
            cube_mesh(f"Adaptive Cube {adaptivity} Mesh"),
            adaptivity=adaptivity,
            include_levels=True,
        )
        for adaptivity in (0.0, 0.1, 0.5, 1.0)
    }


def budget_sdf_probes():
    return {
        "cube_10_voxel_0.1": mesh_sdf_case(
            "Budget Cube 10",
            cube_mesh("Budget Cube 10 Mesh", 10.0),
            voxel_size=0.1,
        ),
    }


print(
    "UV_SDF_PROBE "
    + json.dumps(
        {
            "blender": bpy.app.version_string,
            "uv_unwrap": uv_unwrap_probe(),
            "uv_seams": uv_seam_probes(),
            "uv_pack": {
                str(margin): uv_pack_probe(margin)
                for margin in (0.0, 0.001, 0.1)
            },
            "mesh_sdf": mesh_sdf_probe(),
            "non_manifold_sdf": non_manifold_sdf_probes(),
            "adaptive_sdf": adaptive_sdf_probes(),
            "budget_sdf": budget_sdf_probes(),
        },
        sort_keys=True,
    )
)
