"""Compare Blender's rendered Stippler Voronoi field with CPU shader variants.

Run with Blender so PNG pixels are decoded through Blender's own color
management:

  blender --background --python tools/analyze_stippler_intermediate_fields.py -- \
    generated.png distance.png report.json
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROTATION = 2.159372329711914
SCALE_Y = 1.414306640625
DENSITY = 333.0
RANDOMNESS = 0.4826087951660156


def i32(value: int) -> int:
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value & 0x80000000 else value


def signed_hash3(cell: tuple[int, int, int]) -> tuple[float, float, float]:
    v = [i32(component * 1664525 + 1013904223) for component in cell]
    v[0] = i32(v[0] + i32(v[1] * v[2]))
    v[1] = i32(v[1] + i32(v[2] * v[0]))
    v[2] = i32(v[2] + i32(v[0] * v[1]))
    v = [i32(component ^ (component >> 16)) for component in v]
    v[0] = i32(v[0] + i32(v[1] * v[2]))
    v[1] = i32(v[1] + i32(v[2] * v[0]))
    v[2] = i32(v[2] + i32(v[0] * v[1]))
    return tuple((component & 0x7FFFFFFF) / 2147483647.0 for component in v)


def unsigned_hash3(cell: tuple[int, int, int]) -> tuple[float, float, float]:
    v = [component & 0xFFFFFFFF for component in cell]
    v = [((component * 1664525) + 1013904223) & 0xFFFFFFFF for component in v]
    v[0] = (v[0] + v[1] * v[2]) & 0xFFFFFFFF
    v[1] = (v[1] + v[2] * v[0]) & 0xFFFFFFFF
    v[2] = (v[2] + v[0] * v[1]) & 0xFFFFFFFF
    v = [(component ^ (component >> 16)) & 0xFFFFFFFF for component in v]
    v[0] = (v[0] + v[1] * v[2]) & 0xFFFFFFFF
    v[1] = (v[1] + v[2] * v[0]) & 0xFFFFFFFF
    v[2] = (v[2] + v[0] * v[1]) & 0xFFFFFFFF
    return tuple(component / 4294967295.0 for component in v)


def voronoi_f1(
    generated: tuple[float, float, float],
    *,
    hash_kind: str = "signed",
    rotation_sign: float = 1.0,
    centered_randomness: bool = False,
) -> float:
    x = generated[0]
    y = generated[1] * SCALE_Y
    z = generated[2]
    angle = ROTATION * rotation_sign
    cosine, sine = math.cos(angle), math.sin(angle)
    mapped = (cosine * x - sine * y, sine * x + cosine * y, z)
    point = tuple(component * DENSITY for component in mapped)
    base = tuple(math.floor(component) for component in point)
    local = tuple(component - math.floor(component) for component in point)
    hash_fn = signed_hash3 if hash_kind == "signed" else unsigned_hash3
    nearest = 2.0
    for oz in (-1, 0, 1):
        for oy in (-1, 0, 1):
            for ox in (-1, 0, 1):
                offset = (ox, oy, oz)
                hashed = hash_fn(tuple(base[axis] + offset[axis] for axis in range(3)))
                if centered_randomness:
                    feature = tuple(
                        offset[axis] + 0.5 + (hashed[axis] - 0.5) * RANDOMNESS
                        for axis in range(3)
                    )
                else:
                    feature = tuple(offset[axis] + hashed[axis] * RANDOMNESS for axis in range(3))
                distance = math.sqrt(sum((feature[axis] - local[axis]) ** 2 for axis in range(3)))
                nearest = min(nearest, distance)
    return nearest


def load_pixels(path: str) -> tuple[int, int, list[float]]:
    image = bpy.data.images.load(path, check_existing=False)
    if Path(path).suffix.lower() != ".exr":
        image.colorspace_settings.name = "sRGB"
    pixels = list(image.pixels)
    return image.size[0], image.size[1], pixels


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def stored_to_linear(value: float, path: str) -> float:
    return value if Path(path).suffix.lower() == ".exr" else srgb_to_linear(value)


def correlation(left: list[float], right: list[float]) -> float | None:
    if not left or len(left) != len(right):
        return None
    mean_left = sum(left) / len(left)
    mean_right = sum(right) / len(right)
    numerator = sum((a - mean_left) * (b - mean_right) for a, b in zip(left, right))
    variance_left = sum((a - mean_left) ** 2 for a in left)
    variance_right = sum((b - mean_right) ** 2 for b in right)
    denominator = math.sqrt(variance_left * variance_right)
    return numerator / denominator if denominator > 0 else None


def analytic_generated_coordinate(
    pixel: int,
    width: int,
    height: int,
    metadata: dict,
) -> tuple[float, float, float]:
    minimum = Vector(metadata["geometry"]["bbox"]["min"])
    maximum = Vector(metadata["geometry"]["bbox"]["max"])
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    direction = Vector(metadata["camera"]["direction"])
    radius = max(size.length * 0.5, 0.5)
    location = center + direction * radius * 3.0
    rotation = (center - location).to_track_quat("-Z", "Y")
    right = rotation @ Vector((1.0, 0.0, 0.0))
    up = rotation @ Vector((0.0, 1.0, 0.0))
    forward = rotation @ Vector((0.0, 0.0, -1.0))
    x = pixel % width
    y = pixel // width
    screen_x = (((x + 0.5) / width) * 2.0 - 1.0) * metadata["camera"]["ortho_scale"] * 0.5
    screen_y = (((y + 0.5) / height) * 2.0 - 1.0) * metadata["camera"]["ortho_scale"] * 0.5
    origin = location + right * screen_x + up * screen_y
    world = origin + forward * ((minimum.z - origin.z) / forward.z)
    return (
        (world.x - minimum.x) / size.x,
        (world.y - minimum.y) / size.y,
        0.5,
    )


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) not in (3, 4):
        raise SystemExit("expected: generated image, distance image, report.json, [render metadata.json]")
    generated_path, distance_path, output_path = args[:3]
    metadata = json.loads(Path(args[3]).read_text(encoding="utf-8")) if len(args) == 4 else None
    width, height, generated = load_pixels(generated_path)
    distance_width, distance_height, distance = load_pixels(distance_path)
    if (width, height) != (distance_width, distance_height):
        raise ValueError("render dimensions differ")

    variants = {
        "signed_pcg3d": {},
        "unsigned_pcg3d": {"hash_kind": "unsigned"},
        "signed_reverse_rotation": {"rotation_sign": -1.0},
        "signed_centered_randomness": {"centered_randomness": True},
    }
    observed: list[float] = []
    predicted = {name: [] for name in variants}
    # One sample in each 2x2 pixel block is enough to distinguish the field
    # variants while keeping Blender's Python startup analysis quick.
    for pixel in range(0, width * height, 2):
        offset = pixel * 4
        if generated[offset + 3] < 0.99 or distance[offset + 3] < 0.99:
            continue
        # Image.pixels exposes the stored PNG samples. The debug renders use
        # Standard display transform, so undo its sRGB encoding before using
        # Generated as a procedural coordinate or Distance as a scalar.
        coordinate = (
            analytic_generated_coordinate(pixel, width, height, metadata)
            if metadata
            else tuple(stored_to_linear(generated[offset + axis], generated_path) for axis in range(3))
        )
        observed.append(stored_to_linear(distance[offset], distance_path))
        for name, options in variants.items():
            predicted[name].append(voronoi_f1(coordinate, **options))

    report = {
        "generated": str(Path(generated_path)),
        "distance": str(Path(distance_path)),
        "samples": len(observed),
        "coordinate_source": "analytic_camera_plane" if metadata else "generated_render",
        "observed": {
            "min": min(observed),
            "max": max(observed),
            "mean": sum(observed) / len(observed),
        },
        "variants": {},
    }
    for name, values in predicted.items():
        report["variants"][name] = {
            "correlation": correlation(observed, values),
            "mae": sum(abs(a - b) for a, b in zip(observed, values)) / len(observed),
            "mean": sum(values) / len(values),
        }
    Path(output_path).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
