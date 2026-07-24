"""Render matched Blender Eevee references for the MaterialX lab probe."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


METAL_PRESETS = {
    "aluminum": {
        "ior": (0.729, 0.588, 0.784),
        "extinction": (6.46, 5.196, 4.377),
    },
    "copper": {
        "ior": (0.134, 1.057, 1.686),
        "extinction": (3.106, 2.631, 2.427),
    },
    "gold": {
        "ior": (0.0, 0.352, 1.859),
        "extinction": (6.594, 2.081, 1.496),
    },
    "stainless-steel": {
        "ior": (2.23, 2.041, 2.157),
        "extinction": (4.219, 3.641, 3.074),
    },
    "titanium": {
        "ior": (1.935, 1.868, 2.059),
        "extinction": (2.34, 2.053, 1.745),
    },
}

F82_GOLD = {
    "base_color": (1.0, 0.7758224606513977, 0.3049874007701874, 1.0),
    "edge_tint": (0.9734454154968262, 1.0, 0.9911020398139954, 1.0),
}


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", default="public/materialx/references")
    parser.add_argument("--evidence-dir", default="docs/materialx-evidence/current")
    parser.add_argument("--material", default="chrome.003")
    parser.add_argument("--ui-report", default="public/materialx/ui-normal-band.report.json")
    parser.add_argument("--ui-normal-band-only", action="store_true")
    parser.add_argument("--brushed-roughness-only", action="store_true")
    parser.add_argument("--thin-film-streak-only", action="store_true")
    parser.add_argument("--active-gold-core-only", action="store_true")
    return parser.parse_args(argv)


def look_at(obj, target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 0.0)) -> None:
    position = obj.location.copy()
    forward = (Vector(target) - position).normalized()
    right = forward.cross(Vector(up)).normalized()
    actual_up = right.cross(forward).normalized()
    rotation = Matrix((right, actual_up, -forward)).transposed().to_4x4()
    rotation.translation = position
    obj.matrix_world = rotation


def probe_mesh(width_segments=64, height_segments=32):
    vertices = []
    faces = []
    for y in range(height_segments + 1):
        v = y / height_segments
        phi = v * math.pi
        for x in range(width_segments + 1):
            u = x / width_segments
            theta = u * math.pi * 2.0
            vertices.append((math.sin(phi) * math.cos(theta), math.cos(phi), math.sin(phi) * math.sin(theta)))
    for y in range(height_segments):
        for x in range(width_segments):
            a = y * (width_segments + 1) + x
            b = a + width_segments + 1
            if y != 0:
                faces.append((a, a + 1, b))
            if y != height_segments - 1:
                faces.append((b, a + 1, b + 1))
    mesh = bpy.data.meshes.new("MaterialXProbe")
    mesh.from_pydata(vertices, [], faces)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    rough = mesh.attributes.new("rough", "FLOAT", "POINT")
    for item in rough.data:
        item.value = 0.8
    col = mesh.attributes.new("col", "FLOAT_COLOR", "POINT")
    for item, vertex in zip(col.data, mesh.vertices):
        item.color = tuple((component + 1.0) * 0.5 for component in vertex.co) + (1.0,)
    obj = bpy.data.objects.new("MaterialXProbe", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler[1] = -0.38
    return obj


def floor_mesh():
    segments = 96
    vertices = [(0.0, -1.12, 0.0)] + [
        (3.4 * math.cos(index * 2 * math.pi / segments), -1.12, 3.4 * math.sin(index * 2 * math.pi / segments))
        for index in range(segments)
    ]
    faces = [(0, (index + 1) % segments + 1, index + 1) for index in range(segments)]
    mesh = bpy.data.meshes.new("MaterialXFloor")
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new("MaterialXFloor", mesh)
    bpy.context.scene.collection.objects.link(obj)
    material = bpy.data.materials.new("MaterialXFloor")
    material.diffuse_color = (0.0185, 0.0232, 0.0267, 1.0)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.0185, 0.0232, 0.0267, 1.0)
    principled.inputs["Roughness"].default_value = 0.82
    mesh.materials.append(material)
    return obj


def add_sun(name, position, color, energy):
    data = bpy.data.lights.new(name, "SUN")
    data.color = color
    data.energy = energy
    data.angle = math.radians(8)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    look_at(obj)
    return obj


def write_float_exr(path: Path, name: str, width: int, height: int, pixels: list[float]):
    image = bpy.data.images.new(name, width=width, height=height, alpha=True, float_buffer=True)
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(path)
    image.file_format = "OPEN_EXR"
    image.save()
    bpy.data.images.remove(image)


def sh_basis(direction):
    """Third-order real SH basis in MaterialX's lat-long coordinate frame."""
    x, y, z = direction
    return (
        math.sqrt(1.0 / (4.0 * math.pi)),
        math.sqrt(3.0 / (4.0 * math.pi)) * y,
        math.sqrt(3.0 / (4.0 * math.pi)) * z,
        math.sqrt(3.0 / (4.0 * math.pi)) * x,
        math.sqrt(15.0 / (4.0 * math.pi)) * x * y,
        math.sqrt(15.0 / (4.0 * math.pi)) * y * z,
        math.sqrt(5.0 / (16.0 * math.pi)) * (3.0 * z * z - 1.0),
        math.sqrt(15.0 / (4.0 * math.pi)) * x * z,
        math.sqrt(15.0 / (16.0 * math.pi)) * (x * x - y * y),
    )


def latlong_direction(x: int, y: int, width: int, height: int):
    theta = math.pi * (y + 0.5) / height
    phi = 2.0 * math.pi * (x + 0.5) / width
    radius = math.sin(theta)
    return (-radius * math.sin(phi), -math.cos(theta), radius * math.cos(phi))


def write_irradiance(path: Path, radiance: list[float], width: int, height: int):
    """Project radiance to the same third-order cosine-convolved SH used by MaterialX."""
    coefficients = [[0.0, 0.0, 0.0] for _ in range(9)]
    for y in range(height):
        solid_angle = (math.cos(y * math.pi / height) - math.cos((y + 1) * math.pi / height)) * 2.0 * math.pi / width
        for x in range(width):
            basis = sh_basis(latlong_direction(x, y, width, height))
            offset = (y * width + x) * 4
            color = radiance[offset : offset + 3]
            for coefficient, weight in zip(coefficients, basis):
                for channel in range(3):
                    coefficient[channel] += color[channel] * solid_angle * weight
    cosine_factors = (1.0, 2.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 0.25, 0.25, 0.25, 0.25, 0.25)
    for coefficient, factor in zip(coefficients, cosine_factors):
        for channel in range(3):
            coefficient[channel] *= factor

    output_width, output_height = 64, 32
    output = []
    for y in range(output_height):
        for x in range(output_width):
            basis = sh_basis(latlong_direction(x, y, output_width, output_height))
            color = [
                max(0.0, sum(coefficients[index][channel] * basis[index] for index in range(9)))
                for channel in range(3)
            ]
            output.extend((*color, 1.0))
    write_float_exr(path, "MaterialXStudioIrradiance", output_width, output_height, output)


def write_studio_environment(path: Path, irradiance_path: Path):
    """Write linear radiance and Apache MaterialX-compatible irradiance maps."""
    width, height = 256, 128
    panels = (
        (0.24, 0.38, 0.075, 0.14, (3.2, 4.8, 8.0)),
        (0.50, 0.30, 0.10, 0.11, (8.0, 8.0, 8.0)),
        (0.77, 0.40, 0.075, 0.14, (8.0, 4.8, 2.6)),
        (0.50, 0.78, 0.24, 0.035, (1.2, 1.2, 1.2)),
    )
    pixels = []
    for y in range(height):
        v = (y + 0.5) / height
        for x in range(width):
            u = (x + 0.5) / width
            horizon = 0.018 + 0.025 * max(0.0, 1.0 - abs(v - 0.55) * 3.0)
            color = [horizon, horizon, horizon]
            for center_u, center_v, half_u, half_v, panel_color in panels:
                du = min(abs(u - center_u), 1.0 - abs(u - center_u)) / half_u
                dv = abs(v - center_v) / half_v
                weight = math.exp(-((du ** 8) + (dv ** 8)))
                for channel in range(3):
                    color[channel] += panel_color[channel] * weight
            pixels.extend((*color, 1.0))
    path.parent.mkdir(parents=True, exist_ok=True)
    write_float_exr(path, "MaterialXStudioEnvironment", width, height, pixels)
    write_irradiance(irradiance_path, pixels, width, height)


def configure_scene(environment_path: Path):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    world = bpy.data.worlds.new("MaterialXWorld")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = bpy.data.images.load(str(environment_path), check_existing=False)
    environment.image.colorspace_settings.name = "Linear Rec.709"
    reflected = nodes.new("ShaderNodeBackground")
    reflected.name = "MaterialXReflectedEnvironment"
    reflected.inputs["Strength"].default_value = 0.18
    camera_background = nodes.new("ShaderNodeBackground")
    camera_background.inputs["Color"].default_value = (0.0056, 0.0070, 0.0084, 1.0)
    camera_background.inputs["Strength"].default_value = 1.0
    light_path = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    output = nodes.new("ShaderNodeOutputWorld")
    links.new(environment.outputs["Color"], reflected.inputs["Color"])
    links.new(light_path.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(reflected.outputs[0], mix.inputs[1])
    links.new(camera_background.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs[0])
    scene.world = world

    camera_data = bpy.data.cameras.new("MaterialXCamera")
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = 32
    camera_data.lens = 32 / (2 * math.tan(math.radians(25)))
    camera = bpy.data.objects.new("MaterialXCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = (3.2, 2.2, 3.4)
    look_at(camera)
    scene.camera = camera
    lights = [
        add_sun("Key", (4, 5, 3), (1.0, 1.0, 1.0), 3.2),
        add_sun("Fill", (-4, 2, 2), (0.266, 0.48, 1.0), 1.4),
        add_sun("Rim", (1, 1, -4), (1.0, 0.578, 0.319), 1.8),
    ]
    bpy.context.view_layer.update()
    return camera, lights


def matrix_rows(matrix):
    return [[float(matrix[row][column]) for column in range(4)] for row in range(4)]


def direction_from_local_axis(obj, axis):
    return list((obj.matrix_world.to_3x3() @ Vector(axis)).normalized())


def write_scene_contract(path: Path, camera, lights, probe):
    contract = {
        "schemaVersion": 1,
        "source": "Blender 5.1.2 evaluated matrix_world",
        "coordinateSystem": {
            "blenderWorld": "right-handed Z-up",
            "probeConvention": "geometry and camera deliberately use world +Y as visual up",
            "sunPropagationAxis": "evaluated local -Z",
            "materialXLightData": "direction is propagation direction; generated directional shader negates it",
        },
        "camera": {
            "matrixWorldRows": matrix_rows(camera.matrix_world),
            "right": direction_from_local_axis(camera, (1.0, 0.0, 0.0)),
            "up": direction_from_local_axis(camera, (0.0, 1.0, 0.0)),
            "back": direction_from_local_axis(camera, (0.0, 0.0, 1.0)),
            "forward": direction_from_local_axis(camera, (0.0, 0.0, -1.0)),
            "verticalFovDegrees": math.degrees(camera.data.angle_y),
        },
        "lights": [],
        "probe": {
            "bounds": {
                "space": "object",
                "min": [min(vertex.co[index] for vertex in probe.data.vertices) for index in range(3)],
                "max": [max(vertex.co[index] for vertex in probe.data.vertices) for index in range(3)],
            },
            "geometryProperties": [
                {"name": "rough", "type": "float", "domain": "point"},
                {"name": "col", "type": "color3", "domain": "point"},
            ],
        },
    }
    for light in lights:
        propagation = Vector(direction_from_local_axis(light, (0.0, 0.0, -1.0)))
        contract["lights"].append({
            "name": light.name.lower(),
            "matrixWorldRows": matrix_rows(light.matrix_world),
            "propagationDirection": list(propagation),
            "toLightDirection": list(-propagation),
            "color": list(light.data.color),
            "intensity": float(light.data.energy),
            "angleDegrees": math.degrees(light.data.angle),
        })
    path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")


def smooth_chrome(roughness=0.32):
    material = bpy.data.materials.new("MaterialX Smooth Chrome Diagnostic")
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = roughness
    return material


def physical_conductor(name, ior, extinction, roughness=0.35):
    """Build a rights-safe constant-input Blender Metallic BSDF probe."""
    material = bpy.data.materials.new(f"Physical Conductor Probe · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    conductor = tree.nodes.new("ShaderNodeBsdfMetallic")
    conductor.distribution = "MULTI_GGX"
    conductor.fresnel_type = "PHYSICAL_CONDUCTOR"
    conductor.inputs["IOR"].default_value = ior
    conductor.inputs["Extinction"].default_value = extinction
    conductor.inputs["Roughness"].default_value = roughness
    if conductor.inputs.get("Weight") is not None:
        conductor.inputs["Weight"].default_value = 1.0
    if conductor.inputs.get("Thin Film Thickness") is not None:
        conductor.inputs["Thin Film Thickness"].default_value = 0.0
    if conductor.inputs.get("Thin Film IOR") is not None:
        conductor.inputs["Thin Film IOR"].default_value = 1.33
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(conductor.outputs["BSDF"], output.inputs["Surface"])
    return material


def artistic_f82(
    name,
    base_color,
    edge_tint,
    roughness=0.35,
    anisotropy=0.0,
    rotation=0.0,
    thin_film_thickness=0.0,
    thin_film_ior=1.5,
):
    """Build a rights-safe constant-input Blender Metallic BSDF F82 probe."""
    material = bpy.data.materials.new(f"Artistic F82 Probe · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    metallic = tree.nodes.new("ShaderNodeBsdfMetallic")
    metallic.distribution = "MULTI_GGX"
    metallic.fresnel_type = "F82"
    metallic.inputs["Base Color"].default_value = base_color
    metallic.inputs["Edge Tint"].default_value = edge_tint
    metallic.inputs["Roughness"].default_value = roughness
    metallic.inputs["Anisotropy"].default_value = anisotropy
    metallic.inputs["Rotation"].default_value = rotation
    if anisotropy > 0.0:
        tangent = tree.nodes.new("ShaderNodeTangent")
        tangent.direction_type = "RADIAL"
        tangent.axis = "Y"
        tree.links.new(tangent.outputs["Tangent"], metallic.inputs["Tangent"])
    if metallic.inputs.get("Weight") is not None:
        metallic.inputs["Weight"].default_value = 1.0
    if metallic.inputs.get("Thin Film Thickness") is not None:
        metallic.inputs["Thin Film Thickness"].default_value = thin_film_thickness
    if metallic.inputs.get("Thin Film IOR") is not None:
        metallic.inputs["Thin Film IOR"].default_value = thin_film_ior
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(metallic.outputs["BSDF"], output.inputs["Surface"])
    return material


def artistic_f82_layered(name, base_color, edge_tint, roughness=0.35):
    """Reconstruct the supplied Gold F82 layered-roughness closure chain."""
    material = bpy.data.materials.new(f"Artistic F82 Layered Roughness · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    closures = []
    for scale in (0.25, 0.5, 0.75, 1.0):
        metallic = tree.nodes.new("ShaderNodeBsdfMetallic")
        metallic.distribution = "MULTI_GGX"
        metallic.fresnel_type = "F82"
        metallic.inputs["Base Color"].default_value = base_color
        metallic.inputs["Edge Tint"].default_value = edge_tint
        metallic.inputs["Roughness"].default_value = roughness * scale
        if metallic.inputs.get("Weight") is not None:
            metallic.inputs["Weight"].default_value = 1.0
        if metallic.inputs.get("Thin Film Thickness") is not None:
            metallic.inputs["Thin Film Thickness"].default_value = 0.0
        closures.append(metallic)
    current = closures[0].outputs["BSDF"]
    for closure, factor in zip(closures[1:], (0.4, 0.2, 0.1)):
        mix = tree.nodes.new("ShaderNodeMixShader")
        mix.inputs["Fac"].default_value = factor
        tree.links.new(current, mix.inputs[1])
        tree.links.new(closure.outputs["BSDF"], mix.inputs[2])
        current = mix.outputs["Shader"]
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(current, output.inputs["Surface"])
    return material


def input_by_identifier(node, identifier):
    return next(socket for socket in node.inputs if socket.identifier == identifier)


def output_by_identifier(node, identifier):
    return next(socket for socket in node.outputs if socket.identifier == identifier)


def gold_roughness_fresnel_field(tree, roughness=0.35):
    """Reconstruct the Gold view-dependent roughness field from scalar settings."""
    layer_weight = tree.nodes.new("ShaderNodeLayerWeight")
    layer_weight.inputs["Blend"].default_value = 0.1

    curve = tree.nodes.new("ShaderNodeRGBCurve")
    mapping = curve.mapping
    mapping.extend = "EXTRAPOLATED"
    mapping.tone = "STANDARD"
    mapping.use_clip = True
    mapping.clip_min_x = 0.0
    mapping.clip_min_y = 0.0
    mapping.clip_max_x = 1.0
    mapping.clip_max_y = 1.0
    composite = mapping.curves[3]
    composite.points[0].location = (0.0, 0.5000003576278687)
    composite.points[-1].location = (1.0, 0.0)
    middle = composite.points.new(0.20876851677894592, 0.20121952891349792)
    for point in composite.points:
        point.handle_type = "AUTO"
    mapping.update()

    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "B_SPLINE"
    ramp.color_ramp.color_mode = "RGB"
    ramp.color_ramp.hue_interpolation = "NEAR"
    ramp.color_ramp.elements[0].position = 0.2985386550426483
    ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1.0)
    ramp.color_ramp.elements[1].position = 0.4885174036026001
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)

    multiply_mix = tree.nodes.new("ShaderNodeMix")
    multiply_mix.data_type = "RGBA"
    multiply_mix.blend_type = "MULTIPLY"
    input_by_identifier(multiply_mix, "A_Color").default_value = (
        roughness,
        roughness,
        roughness,
        1.0,
    )
    tree.links.new(layer_weight.outputs["Fresnel"], curve.inputs["Color"])
    tree.links.new(curve.outputs["Color"], ramp.inputs["Fac"])
    tree.links.new(layer_weight.outputs["Fresnel"], input_by_identifier(multiply_mix, "Factor_Float"))
    tree.links.new(ramp.outputs["Color"], input_by_identifier(multiply_mix, "B_Color"))
    return output_by_identifier(multiply_mix, "Result_Color")


def roughness_fresnel_scalar(name, roughness=0.35):
    material = bpy.data.materials.new(f"Roughness Fresnel Scalar · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    field = gold_roughness_fresnel_field(tree, roughness)
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(field, emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def artistic_f82_roughness_fresnel(name, base_color, edge_tint, roughness=0.35):
    material = bpy.data.materials.new(f"Artistic F82 Roughness Fresnel · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    field = gold_roughness_fresnel_field(tree, roughness)
    metallic = tree.nodes.new("ShaderNodeBsdfMetallic")
    metallic.distribution = "MULTI_GGX"
    metallic.fresnel_type = "F82"
    metallic.inputs["Base Color"].default_value = base_color
    metallic.inputs["Edge Tint"].default_value = edge_tint
    if metallic.inputs.get("Weight") is not None:
        metallic.inputs["Weight"].default_value = 1.0
    if metallic.inputs.get("Thin Film Thickness") is not None:
        metallic.inputs["Thin Film Thickness"].default_value = 0.0
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(field, metallic.inputs["Roughness"])
    tree.links.new(metallic.outputs["BSDF"], output.inputs["Surface"])
    return material


def gold_brushed_roughness_field(tree):
    """Reconstruct Gold's active procedural brushed-roughness branch.

    The supplied Gold material drives this branch with Generated coordinates.
    Its packed scratch-image branches are intentionally absent so this
    rights-safe probe isolates only the authored procedural noise contribution.
    """
    base = gold_roughness_fresnel_field(tree, roughness=0.44999995827674866)

    coordinates = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.vector_type = "POINT"
    mapping.inputs["Location"].default_value = (0.0, 0.0, 0.0)
    mapping.inputs["Rotation"].default_value = (0.0, 0.0, 0.0)
    mapping.inputs["Scale"].default_value = (100.0, 100.0, 100.0)

    length = tree.nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    length_vector = tree.nodes.new("ShaderNodeCombineXYZ")
    coordinate_mix = tree.nodes.new("ShaderNodeMix")
    coordinate_mix.data_type = "VECTOR"
    input_by_identifier(coordinate_mix, "Factor_Float").default_value = 0.9549999833106995

    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "3D"
    noise.noise_type = "FBM"
    noise.normalize = True
    noise.inputs["Scale"].default_value = 20.0
    noise.inputs["Detail"].default_value = 2.0
    noise.inputs["Roughness"].default_value = 0.5
    noise.inputs["Lacunarity"].default_value = 2.0
    noise.inputs["Distortion"].default_value = 0.0

    brush_mask = tree.nodes.new("ShaderNodeMapRange")
    brush_mask.data_type = "FLOAT"
    brush_mask.interpolation_type = "LINEAR"
    brush_mask.clamp = True
    brush_mask.inputs["From Min"].default_value = 0.3999999761581421
    brush_mask.inputs["From Max"].default_value = 1.0
    brush_mask.inputs["To Min"].default_value = 0.0
    brush_mask.inputs["To Max"].default_value = 0.27300000190734863

    # Gold's Mix.111 ADD stage has zero anisotropy as A, the noise as B, and
    # the remapped noise as its factor.
    brushed_add = tree.nodes.new("ShaderNodeMix")
    brushed_add.data_type = "RGBA"
    brushed_add.blend_type = "ADD"
    input_by_identifier(brushed_add, "A_Color").default_value = (0.0, 0.0, 0.0, 1.0)

    # Mix.113 applies the brushed contribution to the already-validated
    # roughness-Fresnel field with a full-strength SCREEN blend.
    screen = tree.nodes.new("ShaderNodeMix")
    screen.data_type = "RGBA"
    screen.blend_type = "SCREEN"
    input_by_identifier(screen, "Factor_Float").default_value = 1.0

    tree.links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], length.inputs[0])
    for axis in ("X", "Y", "Z"):
        tree.links.new(length.outputs["Value"], length_vector.inputs[axis])
    tree.links.new(mapping.outputs["Vector"], input_by_identifier(coordinate_mix, "A_Vector"))
    tree.links.new(length_vector.outputs["Vector"], input_by_identifier(coordinate_mix, "B_Vector"))
    tree.links.new(output_by_identifier(coordinate_mix, "Result_Vector"), noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], brush_mask.inputs["Value"])
    tree.links.new(brush_mask.outputs["Result"], input_by_identifier(brushed_add, "Factor_Float"))
    tree.links.new(noise.outputs["Fac"], input_by_identifier(brushed_add, "B_Color"))
    tree.links.new(base, input_by_identifier(screen, "A_Color"))
    tree.links.new(output_by_identifier(brushed_add, "Result_Color"), input_by_identifier(screen, "B_Color"))
    return output_by_identifier(screen, "Result_Color")


def brushed_roughness_scalar(name):
    material = bpy.data.materials.new(f"Brushed Roughness Scalar · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    field = gold_brushed_roughness_field(tree)
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(field, emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def artistic_f82_brushed_roughness(name, base_color, edge_tint):
    material = bpy.data.materials.new(f"Artistic F82 Brushed Roughness · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    field = gold_brushed_roughness_field(tree)
    metallic = tree.nodes.new("ShaderNodeBsdfMetallic")
    metallic.distribution = "MULTI_GGX"
    metallic.fresnel_type = "F82"
    metallic.inputs["Base Color"].default_value = base_color
    metallic.inputs["Edge Tint"].default_value = edge_tint
    if metallic.inputs.get("Weight") is not None:
        metallic.inputs["Weight"].default_value = 1.0
    if metallic.inputs.get("Thin Film Thickness") is not None:
        metallic.inputs["Thin Film Thickness"].default_value = 0.0
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(field, metallic.inputs["Roughness"])
    tree.links.new(metallic.outputs["BSDF"], output.inputs["Surface"])
    return material


def gold_active_core_roughness_field(tree):
    """Build active Gold roughness with both unlicensed scratch maps bypassed.

    Material.011 drives the dense and sparse scratch factors at nonzero values,
    but their packed source images do not carry a standalone redistribution
    license.  This checkpoint forces both factors to zero while retaining the
    active roughness-Fresnel and procedural brushed-metal branches.
    """
    field = gold_brushed_roughness_field(tree)
    for _label in ("Dense Scratches = 0", "Sparse Scratches = 0"):
        bypass = tree.nodes.new("ShaderNodeMix")
        bypass.label = _label
        bypass.data_type = "RGBA"
        bypass.blend_type = "EXCLUSION"
        input_by_identifier(bypass, "Factor_Float").default_value = 0.0
        input_by_identifier(bypass, "B_Color").default_value = (0.0, 0.0, 0.0, 1.0)
        tree.links.new(field, input_by_identifier(bypass, "A_Color"))
        field = output_by_identifier(bypass, "Result_Color")
    return field


def active_gold_core_scalar(name):
    material = bpy.data.materials.new(f"Active Gold Core Scalar · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    field = gold_active_core_roughness_field(tree)
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(field, emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def physical_conductor_active_gold_core(name):
    """Reconstruct active Gold's non-image PHYSICAL_CONDUCTOR closure chain."""
    material = bpy.data.materials.new(f"Physical Conductor Active Gold Core · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    roughness = gold_active_core_roughness_field(tree)
    closures = []
    for index, scale in enumerate((0.25, 0.5, 0.75, 1.0)):
        scaled = tree.nodes.new("ShaderNodeMath")
        scaled.label = f"Active roughness × {scale:g}"
        scaled.operation = "MULTIPLY"
        scaled.inputs[1].default_value = scale
        tree.links.new(roughness, scaled.inputs[0])

        conductor = tree.nodes.new("ShaderNodeBsdfMetallic")
        conductor.label = f"Gold PHYSICAL_CONDUCTOR layer {index + 1}"
        conductor.distribution = "MULTI_GGX"
        conductor.fresnel_type = "PHYSICAL_CONDUCTOR"
        conductor.inputs["IOR"].default_value = METAL_PRESETS["gold"]["ior"]
        conductor.inputs["Extinction"].default_value = METAL_PRESETS["gold"]["extinction"]
        if conductor.inputs.get("Weight") is not None:
            conductor.inputs["Weight"].default_value = 1.0
        if conductor.inputs.get("Thin Film Thickness") is not None:
            conductor.inputs["Thin Film Thickness"].default_value = 0.0
        if conductor.inputs.get("Thin Film IOR") is not None:
            conductor.inputs["Thin Film IOR"].default_value = 2.4600000381469727
        tree.links.new(scaled.outputs["Value"], conductor.inputs["Roughness"])
        closures.append(conductor)

    current = closures[0].outputs["BSDF"]
    for closure, factor in zip(closures[1:], (0.4, 0.2, 0.1)):
        mix = tree.nodes.new("ShaderNodeMixShader")
        mix.inputs["Fac"].default_value = factor
        tree.links.new(current, mix.inputs[1])
        tree.links.new(closure.outputs["BSDF"], mix.inputs[2])
        current = mix.outputs["Shader"]
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(current, output.inputs["Surface"])
    return material


def gold_thin_film_streak_field(tree):
    """Reconstruct the activated Gold procedural thin-film thickness field.

    Material.011 leaves Gold Socket_27 unlinked at zero, which makes the
    authored branch exactly 0 nm. This diagnostic deliberately binds that
    socket to Generated coordinates so the recoverable spatial semantics can
    be compared without claiming that the supplied instance is nonzero.
    """

    coordinates = tree.nodes.new("ShaderNodeTexCoord")

    shared_mapping = tree.nodes.new("ShaderNodeMapping")
    shared_mapping.vector_type = "POINT"
    shared_mapping.inputs["Location"].default_value = (0.0, 0.0, 0.0)
    shared_mapping.inputs["Rotation"].default_value = (0.0, 0.0, 0.0)
    shared_mapping.inputs["Scale"].default_value = (100.0, 100.0, 100.0)
    shared_length = tree.nodes.new("ShaderNodeVectorMath")
    shared_length.operation = "LENGTH"
    shared_length_vector = tree.nodes.new("ShaderNodeCombineXYZ")
    shared_mix = tree.nodes.new("ShaderNodeMix")
    shared_mix.data_type = "VECTOR"
    input_by_identifier(shared_mix, "Factor_Float").default_value = 0.9549999833106995
    shared_noise = tree.nodes.new("ShaderNodeTexNoise")
    shared_noise.noise_dimensions = "3D"
    shared_noise.noise_type = "FBM"
    shared_noise.normalize = True
    shared_noise.inputs["Scale"].default_value = 20.0
    shared_noise.inputs["Detail"].default_value = 2.0
    shared_noise.inputs["Roughness"].default_value = 0.5
    shared_noise.inputs["Lacunarity"].default_value = 2.0
    shared_noise.inputs["Distortion"].default_value = 0.0
    shared_gate = tree.nodes.new("ShaderNodeMapRange")
    shared_gate.data_type = "FLOAT"
    shared_gate.interpolation_type = "LINEAR"
    shared_gate.clamp = True
    shared_gate.inputs["From Min"].default_value = 0.29999998211860657
    shared_gate.inputs["From Max"].default_value = 0.5999999046325684
    shared_gate.inputs["To Min"].default_value = 0.0
    shared_gate.inputs["To Max"].default_value = 0.5999999046325684

    thin_film_mapping = tree.nodes.new("ShaderNodeMapping")
    thin_film_mapping.vector_type = "POINT"
    thin_film_mapping.inputs["Location"].default_value = (0.0, 0.0, 0.0)
    thin_film_mapping.inputs["Rotation"].default_value = (0.0, 0.0, 0.0)
    thin_film_mapping.inputs["Scale"].default_value = (90.0, 90.0, 90.0)
    thin_film_length = tree.nodes.new("ShaderNodeVectorMath")
    thin_film_length.operation = "LENGTH"
    thin_film_length_vector = tree.nodes.new("ShaderNodeCombineXYZ")
    thin_film_mix = tree.nodes.new("ShaderNodeMix")
    thin_film_mix.data_type = "VECTOR"
    input_by_identifier(thin_film_mix, "Factor_Float").default_value = 0.7501863837242126
    thin_film_noise = tree.nodes.new("ShaderNodeTexNoise")
    thin_film_noise.noise_dimensions = "3D"
    thin_film_noise.noise_type = "FBM"
    thin_film_noise.normalize = False
    thin_film_noise.inputs["Scale"].default_value = 10.0
    thin_film_noise.inputs["Detail"].default_value = 2.0
    thin_film_noise.inputs["Roughness"].default_value = 0.5
    thin_film_noise.inputs["Lacunarity"].default_value = 2.0
    thin_film_noise.inputs["Distortion"].default_value = 0.0
    thin_film_ramp = tree.nodes.new("ShaderNodeValToRGB")
    thin_film_ramp.color_ramp.interpolation = "B_SPLINE"
    thin_film_ramp.color_ramp.color_mode = "RGB"
    thin_film_ramp.color_ramp.hue_interpolation = "NEAR"
    thin_film_ramp.color_ramp.elements[0].position = 0.10647183656692505
    thin_film_ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1.0)
    thin_film_ramp.color_ramp.elements[1].position = 1.0
    thin_film_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)

    mask = tree.nodes.new("ShaderNodeMix")
    mask.data_type = "RGBA"
    mask.blend_type = "MULTIPLY"
    input_by_identifier(mask, "Factor_Float").default_value = 1.0
    thickness = tree.nodes.new("ShaderNodeMath")
    thickness.operation = "MULTIPLY"
    thickness.inputs[1].default_value = 1390.0

    for mapping, length, length_vector, coordinate_mix in (
        (shared_mapping, shared_length, shared_length_vector, shared_mix),
        (thin_film_mapping, thin_film_length, thin_film_length_vector, thin_film_mix),
    ):
        tree.links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
        tree.links.new(mapping.outputs["Vector"], length.inputs[0])
        for axis in ("X", "Y", "Z"):
            tree.links.new(length.outputs["Value"], length_vector.inputs[axis])
        tree.links.new(mapping.outputs["Vector"], input_by_identifier(coordinate_mix, "A_Vector"))
        tree.links.new(length_vector.outputs["Vector"], input_by_identifier(coordinate_mix, "B_Vector"))

    tree.links.new(output_by_identifier(shared_mix, "Result_Vector"), shared_noise.inputs["Vector"])
    tree.links.new(shared_noise.outputs["Fac"], shared_gate.inputs["Value"])
    tree.links.new(output_by_identifier(thin_film_mix, "Result_Vector"), thin_film_noise.inputs["Vector"])
    tree.links.new(thin_film_noise.outputs["Fac"], thin_film_ramp.inputs["Fac"])
    tree.links.new(thin_film_ramp.outputs["Color"], input_by_identifier(mask, "A_Color"))
    tree.links.new(shared_gate.outputs["Result"], input_by_identifier(mask, "B_Color"))
    tree.links.new(output_by_identifier(mask, "Result_Color"), thickness.inputs[0])
    return output_by_identifier(mask, "Result_Color"), thickness.outputs["Value"]


def thin_film_streak_scalar(name):
    material = bpy.data.materials.new(f"Thin Film Streak Scalar · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    mask, _thickness = gold_thin_film_streak_field(tree)
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(mask, emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def artistic_f82_thin_film_streak(name, base_color, edge_tint):
    material = bpy.data.materials.new(f"Artistic F82 Thin Film Streak · {name}")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    _mask, thickness = gold_thin_film_streak_field(tree)
    metallic = tree.nodes.new("ShaderNodeBsdfMetallic")
    metallic.distribution = "MULTI_GGX"
    metallic.fresnel_type = "F82"
    metallic.inputs["Base Color"].default_value = base_color
    metallic.inputs["Edge Tint"].default_value = edge_tint
    metallic.inputs["Roughness"].default_value = 0.44999995827674866
    if metallic.inputs.get("Weight") is not None:
        metallic.inputs["Weight"].default_value = 1.0
    tree.links.new(thickness, metallic.inputs["Thin Film Thickness"])
    metallic.inputs["Thin Film IOR"].default_value = 2.4600000381469727
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(metallic.outputs["BSDF"], output.inputs["Surface"])
    return material


def ui_normal_band_diagnostic(report_path: Path):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    lowering = report["diagnosticLowering"]
    property_name = report["activeGraph"]["geometryProperties"][0]["name"]
    material = bpy.data.materials.new("MaterialX UI Normal Band Semantic Diagnostic")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    texcoord = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.vector_type = "POINT"
    mapping.inputs["Rotation"].default_value = lowering["rotationRadians"]
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    while len(ramp.color_ramp.elements) > 1:
        ramp.color_ramp.elements.remove(ramp.color_ramp.elements[-1])
    first = lowering["constantRamp"][0]
    ramp.color_ramp.elements[0].position = first["position"]
    ramp.color_ramp.elements[0].color = (*first["color"], 1.0)
    for entry in lowering["constantRamp"][1:]:
        element = ramp.color_ramp.elements.new(entry["position"])
        element.color = (*entry["color"], 1.0)
    attribute = tree.nodes.new("ShaderNodeAttribute")
    attribute.attribute_type = "GEOMETRY"
    attribute.attribute_name = property_name
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    input_by_identifier(mix, "Factor_Float").default_value = lowering["mixFactor"]
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(texcoord.outputs["Normal"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], input_by_identifier(mix, "A_Color"))
    tree.links.new(attribute.outputs["Color"], input_by_identifier(mix, "B_Color"))
    tree.links.new(output_by_identifier(mix, "Result_Color"), emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def render_light_diagnostics(output: Path, probe, lights):
    probe.data.materials[0] = smooth_chrome()
    environment = bpy.context.scene.world.node_tree.nodes["MaterialXReflectedEnvironment"]
    original_environment_strength = environment.inputs["Strength"].default_value
    environment.inputs["Strength"].default_value = 0.0
    original_energies = {light.name: light.data.energy for light in lights}
    original_angles = {light.name: light.data.angle for light in lights}
    for selected in lights:
        for light in lights:
            light.data.energy = original_energies[light.name] if light == selected else 0.0
            light.data.angle = 0.0
        bpy.context.scene.render.filepath = str(output / f"light-{selected.name.lower()}-blender.png")
        bpy.ops.render.render(write_still=True)
    environment.inputs["Strength"].default_value = original_environment_strength
    for light in lights:
        light.data.energy = original_energies[light.name]
        light.data.angle = original_angles[light.name]


def roughness_slug(value: float) -> str:
    return format(value, ".7g").replace(".", "p")


def render_environment_roughness_sweep(output: Path, probe, floor, lights):
    """Render the shared environment without direct lights or floor occlusion."""
    original_energies = {light.name: light.data.energy for light in lights}
    original_floor_visibility = floor.hide_render
    for light in lights:
        light.data.energy = 0.0
    floor.hide_render = True
    try:
        for roughness in (0.0, 2.0 / 15.0, 0.2610441):
            probe.data.materials[0] = smooth_chrome(roughness)
            bpy.context.scene.render.filepath = str(
                output / f"roughness-{roughness_slug(roughness)}-blender.png"
            )
            bpy.ops.render.render(write_still=True)
    finally:
        floor.hide_render = original_floor_visibility
        for light in lights:
            light.data.energy = original_energies[light.name]


def render_physical_conductor_matrix(output: Path, probe, floor, lights):
    """Render representative constant-input presets without the source add-on graph."""
    original_energies = {light.name: light.data.energy for light in lights}
    original_floor_visibility = floor.hide_render
    scene = bpy.context.scene
    original_engine = scene.render.engine
    original_cycles_samples = scene.cycles.samples
    original_cycles_denoising = scene.cycles.use_denoising
    background = bpy.context.scene.world.node_tree.nodes["MaterialXReflectedEnvironment"]
    original_environment_strength = background.inputs["Strength"].default_value
    for light in lights:
        light.data.energy = 0.0
    floor.hide_render = True
    try:
        for name, preset in METAL_PRESETS.items():
            probe.data.materials[0] = physical_conductor(
                name,
                preset["ior"],
                preset["extinction"],
            )
            bpy.context.scene.render.filepath = str(
                output / f"metal-preset-{name}-blender.png"
            )
            bpy.ops.render.render(write_still=True)
        probe.data.materials[0] = artistic_f82(
            "Gold",
            F82_GOLD["base_color"],
            F82_GOLD["edge_tint"],
        )
        bpy.context.scene.render.filepath = str(output / "metal-f82-gold-blender.png")
        bpy.ops.render.render(write_still=True)
        probe.data.materials[0] = artistic_f82_layered(
            "Gold",
            F82_GOLD["base_color"],
            F82_GOLD["edge_tint"],
        )
        bpy.context.scene.render.filepath = str(
            output / "metal-layered-roughness-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)
        probe.data.materials[0] = artistic_f82_roughness_fresnel(
            "Gold",
            F82_GOLD["base_color"],
            F82_GOLD["edge_tint"],
        )
        bpy.context.scene.render.filepath = str(
            output / "metal-roughness-fresnel-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)
        background.inputs["Strength"].default_value = 0.0
        probe.data.materials[0] = roughness_fresnel_scalar("Gold")
        bpy.context.scene.render.filepath = str(
            output / "metal-roughness-fresnel-scalar-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)
        background.inputs["Strength"].default_value = 0.0
        lights[0].data.energy = original_energies[lights[0].name]
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 128
        scene.cycles.use_denoising = False
        for rotation, slug in ((0.0, "r0"), (0.25, "r90")):
            probe.data.materials[0] = artistic_f82(
                f"Gold Anisotropy {slug}",
                F82_GOLD["base_color"],
                F82_GOLD["edge_tint"],
                anisotropy=0.8,
                rotation=rotation,
            )
            bpy.context.scene.render.filepath = str(
                output / f"metal-anisotropy-gold-{slug}-blender.png"
            )
            bpy.ops.render.render(write_still=True)
        for thickness in (0.0, 243.0):
            probe.data.materials[0] = artistic_f82(
                f"Gold Thin Film {thickness:g}nm",
                F82_GOLD["base_color"],
                F82_GOLD["edge_tint"],
                thin_film_thickness=thickness,
                thin_film_ior=2.46,
            )
            bpy.context.scene.render.filepath = str(
                output / f"metal-thin-film-gold-{thickness:g}nm-blender.png"
            )
            bpy.ops.render.render(write_still=True)
    finally:
        scene.cycles.use_denoising = original_cycles_denoising
        scene.cycles.samples = original_cycles_samples
        scene.render.engine = original_engine
        background.inputs["Strength"].default_value = original_environment_strength
        floor.hide_render = original_floor_visibility
        for light in lights:
            light.data.energy = original_energies[light.name]


def render_gold_brushed_roughness(output: Path, probe, floor, lights):
    """Render the isolated active Gold brush branch under the shared contract."""
    original_energies = {light.name: light.data.energy for light in lights}
    original_floor_visibility = floor.hide_render
    background = bpy.context.scene.world.node_tree.nodes["MaterialXReflectedEnvironment"]
    original_environment_strength = background.inputs["Strength"].default_value
    for light in lights:
        light.data.energy = 0.0
    floor.hide_render = True
    try:
        background.inputs["Strength"].default_value = 0.18
        beauty = artistic_f82_brushed_roughness(
            "Gold",
            F82_GOLD["base_color"],
            F82_GOLD["edge_tint"],
        )
        if probe.data.materials:
            probe.data.materials[0] = beauty
        else:
            probe.data.materials.append(beauty)
        bpy.context.scene.render.filepath = str(
            output / "metal-brushed-roughness-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)

        background.inputs["Strength"].default_value = 0.0
        probe.data.materials[0] = brushed_roughness_scalar("Gold")
        bpy.context.scene.render.filepath = str(
            output / "metal-brushed-roughness-scalar-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)
    finally:
        background.inputs["Strength"].default_value = original_environment_strength
        floor.hide_render = original_floor_visibility
        for light in lights:
            light.data.energy = original_energies[light.name]


def render_gold_thin_film_streak(output: Path, probe, floor, lights):
    """Render the explicit Generated-coordinate activation of Gold's streak."""
    scene = bpy.context.scene
    original_engine = scene.render.engine
    original_cycles_samples = scene.cycles.samples
    original_cycles_denoising = scene.cycles.use_denoising
    original_eevee_samples = scene.eevee.taa_render_samples
    original_energies = {light.name: light.data.energy for light in lights}
    original_floor_visibility = floor.hide_render
    background = scene.world.node_tree.nodes["MaterialXReflectedEnvironment"]
    original_environment_strength = background.inputs["Strength"].default_value
    for light in lights:
        light.data.energy = 0.0
    floor.hide_render = True
    background.inputs["Strength"].default_value = 0.0
    try:
        lights[0].data.energy = original_energies[lights[0].name]
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 128
        scene.cycles.use_denoising = False
        beauty = artistic_f82_thin_film_streak(
            "Gold",
            F82_GOLD["base_color"],
            F82_GOLD["edge_tint"],
        )
        if probe.data.materials:
            probe.data.materials[0] = beauty
        else:
            probe.data.materials.append(beauty)
        scene.render.filepath = str(
            output / "metal-thin-film-streak-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)

        lights[0].data.energy = 0.0
        scene.render.engine = original_engine
        # The browser evaluates this high-frequency scalar once per pixel.
        # Disable Eevee's 64-sample temporal averaging for the semantic field
        # comparison; the Cycles beauty retains its independent 128 samples.
        scene.eevee.taa_render_samples = 1
        probe.data.materials[0] = thin_film_streak_scalar("Gold")
        scene.render.filepath = str(
            output / "metal-thin-film-streak-scalar-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)
    finally:
        scene.cycles.use_denoising = original_cycles_denoising
        scene.cycles.samples = original_cycles_samples
        scene.eevee.taa_render_samples = original_eevee_samples
        scene.render.engine = original_engine
        background.inputs["Strength"].default_value = original_environment_strength
        floor.hide_render = original_floor_visibility
        for light in lights:
            light.data.energy = original_energies[light.name]


def render_active_gold_core(output: Path, probe, floor, lights):
    """Render active Gold with dense/sparse scratch factors forced to zero."""
    original_energies = {light.name: light.data.energy for light in lights}
    original_floor_visibility = floor.hide_render
    background = bpy.context.scene.world.node_tree.nodes["MaterialXReflectedEnvironment"]
    original_environment_strength = background.inputs["Strength"].default_value
    for light in lights:
        light.data.energy = 0.0
    floor.hide_render = True
    try:
        background.inputs["Strength"].default_value = 0.18
        beauty = physical_conductor_active_gold_core("Gold")
        if probe.data.materials:
            probe.data.materials[0] = beauty
        else:
            probe.data.materials.append(beauty)
        bpy.context.scene.render.filepath = str(
            output / "metal-active-gold-core-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)

        background.inputs["Strength"].default_value = 0.0
        probe.data.materials[0] = active_gold_core_scalar("Gold")
        bpy.context.scene.render.filepath = str(
            output / "metal-active-gold-core-scalar-gold-blender.png"
        )
        bpy.ops.render.render(write_still=True)
    finally:
        background.inputs["Strength"].default_value = original_environment_strength
        floor.hide_render = original_floor_visibility
        for light in lights:
            light.data.energy = original_energies[light.name]


def bump_copy(_source):
    material = bpy.data.materials.new("MaterialX Noise Bump Probe")
    material.use_nodes = True
    material.name = "MaterialX Noise Bump Probe"
    tree = material.node_tree
    principled = tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = 0.32
    geometry = tree.nodes.new("ShaderNodeNewGeometry")
    mapping = tree.nodes.new("ShaderNodeVectorMath")
    mapping.operation = "SCALE"
    mapping.inputs[3].default_value = 4.0
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "3D"
    noise.inputs["Scale"].default_value = 1.0
    noise.inputs["Detail"].default_value = 2.0
    noise.inputs["Roughness"].default_value = 0.5
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.18
    bump.inputs["Distance"].default_value = 0.1
    tree.links.new(geometry.outputs["Position"], mapping.inputs[0])
    tree.links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def main():
    options = args()
    runtime = Path(options.runtime_dir).resolve()
    evidence = Path(options.evidence_dir).resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    evidence.mkdir(parents=True, exist_ok=True)
    environment_path = runtime / "studio-environment.exr"
    irradiance_path = runtime / "studio-irradiance.exr"
    write_studio_environment(environment_path, irradiance_path)
    source = bpy.data.materials.get(options.material)
    if source is None:
        raise RuntimeError(f"Missing source material {options.material!r}")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    camera, lights = configure_scene(environment_path)
    probe = probe_mesh()
    write_scene_contract(runtime / "scene-contract.json", camera, lights, probe)
    floor = floor_mesh()
    if options.ui_normal_band_only:
        probe.data.materials.append(ui_normal_band_diagnostic(Path(options.ui_report).resolve()))
        bpy.context.scene.render.filepath = str(evidence / "ui-normal-band-blender.png")
        bpy.ops.render.render(write_still=True)
        print(f"MATERIALX_BLENDER_REFERENCE ui-normal-band-blender.png -> {evidence}")
        return
    if options.brushed_roughness_only:
        render_gold_brushed_roughness(evidence, probe, floor, lights)
        print(f"MATERIALX_BLENDER_REFERENCE metal-brushed-roughness-{{scalar-,}}gold-blender.png -> {evidence}")
        return
    if options.thin_film_streak_only:
        render_gold_thin_film_streak(evidence, probe, floor, lights)
        print(f"MATERIALX_BLENDER_REFERENCE metal-thin-film-streak-{{scalar-,}}gold-blender.png -> {evidence}")
        return
    if options.active_gold_core_only:
        render_active_gold_core(evidence, probe, floor, lights)
        print(f"MATERIALX_BLENDER_REFERENCE metal-active-gold-core-{{scalar-,}}gold-blender.png -> {evidence}")
        return
    source.use_nodes = True
    probe.data.materials.append(source)
    bpy.context.scene.render.filepath = str(evidence / "chrome-source-blender.png")
    bpy.ops.render.render(write_still=True)
    probe.data.materials[0] = bump_copy(source)
    bpy.context.scene.render.filepath = str(evidence / "noise-bump-blender.png")
    bpy.ops.render.render(write_still=True)
    # Preserve the probe's non-identity rotation so the portable branch must
    # reproduce Blender Texture Coordinate Normal in world space.
    bpy.context.view_layer.update()
    probe.data.materials[0] = ui_normal_band_diagnostic(Path(options.ui_report).resolve())
    bpy.context.scene.render.filepath = str(evidence / "ui-normal-band-blender.png")
    bpy.ops.render.render(write_still=True)
    render_light_diagnostics(evidence, probe, lights)
    render_environment_roughness_sweep(evidence, probe, floor, lights)
    render_physical_conductor_matrix(evidence, probe, floor, lights)
    render_gold_brushed_roughness(evidence, probe, floor, lights)
    render_gold_thin_film_streak(evidence, probe, floor, lights)
    render_active_gold_core(evidence, probe, floor, lights)
    print(f"MATERIALX_BLENDER_REFERENCES {evidence}")


if __name__ == "__main__":
    main()
