"""Compare aligned Blender and WebGL authored-material captures.

Usage:
  blender --background --python tools/compare_stippler_shader_masks.py -- \
    BLENDER.png WEBGL.png OUT.json [WEBGL_BACKGROUND_HEX] [WEBGL_SAMPLES]

The Blender capture must have a transparent background. The opt-in WebGL
``capture=authored`` and legacy ``capture=stippler-shader`` routes use #ff00ff
as a segmentation background by default. Pass a different six-digit key when
the authored material itself legitimately contains magenta. The script name is
retained for compatibility with the existing Stippler evidence pipeline.
"""
import json
import math
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 3:
    raise RuntimeError("expected BLENDER.png WEBGL.png OUT.json")
blender_path, webgl_path, out_path = map(os.path.abspath, args[:3])
webgl_background_hex = args[3] if len(args) > 3 else "ff00ff"
webgl_samples = int(args[4]) if len(args) > 4 else None
if len(webgl_background_hex) != 6:
    raise RuntimeError("WEBGL_BACKGROUND_HEX must contain exactly six hexadecimal digits")
if webgl_samples is not None and webgl_samples < 1:
    raise RuntimeError("WEBGL_SAMPLES must be a positive integer")
try:
    webgl_background = tuple(int(webgl_background_hex[offset:offset + 2], 16) / 255 for offset in (0, 2, 4))
except ValueError as error:
    raise RuntimeError("WEBGL_BACKGROUND_HEX must contain exactly six hexadecimal digits") from error


def load(path):
    image = bpy.data.images.load(path, check_existing=False)
    width, height = image.size
    values = list(image.pixels)
    pixels = [tuple(values[offset:offset + 4]) for offset in range(0, len(values), 4)]
    return width, height, pixels


def luminance(pixel):
    return 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]


def composite_over(pixel, background):
    alpha = pixel[3]
    return (
        pixel[0] * alpha + background[0] * (1 - alpha),
        pixel[1] * alpha + background[1] * (1 - alpha),
        pixel[2] * alpha + background[2] * (1 - alpha),
        1.0,
    )


def differs_from_key(pixel, background, tolerance):
    return max(abs(pixel[channel] - background[channel]) for channel in range(3)) > tolerance


def fraction(value, total):
    return value / total if total else None


def mask_stats(mask, values):
    selected = [values[index] for index, enabled in enumerate(mask) if enabled]
    black = sum(value < 0.1 for value in selected)
    white = sum(value > 0.9 for value in selected)
    gray = len(selected) - black - white
    return {
        "surface_pixels": len(selected),
        "black_pixels": black,
        "white_pixels": white,
        "gray_pixels": gray,
        "black_fraction": fraction(black, len(selected)),
        "white_fraction": fraction(white, len(selected)),
        "gray_fraction": fraction(gray, len(selected)),
        "mean_luminance": sum(selected) / len(selected) if selected else None,
    }


def correlation(left, right):
    if len(left) < 2 or len(left) != len(right):
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    left_energy = sum((a - left_mean) ** 2 for a in left)
    right_energy = sum((b - right_mean) ** 2 for b in right)
    denominator = math.sqrt(left_energy * right_energy)
    return numerator / denominator if denominator else None


def silhouette_corners(mask, width, height):
    coordinates = [(index % width, index // width) for index, enabled in enumerate(mask) if enabled]
    if not coordinates:
        return None

    def average(points):
        return [sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)]

    min_x = min(point[0] for point in coordinates)
    max_x = max(point[0] for point in coordinates)
    min_y = min(point[1] for point in coordinates)
    max_y = max(point[1] for point in coordinates)
    return {
        "left": average([point for point in coordinates if point[0] <= min_x + 1]),
        "right": average([point for point in coordinates if point[0] >= max_x - 1]),
        "bottom": average([point for point in coordinates if point[1] <= min_y + 1]),
        "top": average([point for point in coordinates if point[1] >= max_y - 1]),
    }


def dilate(mask, width, height, radius=1):
    result = [False] * len(mask)
    for index, enabled in enumerate(mask):
        if not enabled:
            continue
        x = index % width
        y = index // width
        for sample_y in range(max(0, y - radius), min(height, y + radius + 1)):
            row = sample_y * width
            for sample_x in range(max(0, x - radius), min(width, x + radius + 1)):
                result[row + sample_x] = True
    return result


width, height, blender_source_pixels = load(blender_path)
webgl_width, webgl_height, webgl_pixels = load(webgl_path)
if (width, height) != (webgl_width, webgl_height):
    raise RuntimeError(f"capture sizes differ: {(width, height)} != {(webgl_width, webgl_height)}")

webgl_key_tolerance = 0.08
blender_alpha_mask = [pixel[3] > 0.5 for pixel in blender_source_pixels]
blender_pixels = [
    composite_over(pixel, webgl_background)
    for pixel in blender_source_pixels
]
blender_mask = [
    differs_from_key(pixel, webgl_background, webgl_key_tolerance)
    for pixel in blender_pixels
]
webgl_mask = [
    differs_from_key(pixel, webgl_background, webgl_key_tolerance)
    for pixel in webgl_pixels
]
blender_luminance = [luminance(pixel) for pixel in blender_pixels]
webgl_luminance = [luminance(pixel) for pixel in webgl_pixels]
intersection = [left and right for left, right in zip(blender_mask, webgl_mask)]
union = [left or right for left, right in zip(blender_mask, webgl_mask)]
intersection_count = sum(intersection)
union_count = sum(union)
blender_dilated_1px = dilate(blender_mask, width, height)
webgl_dilated_1px = dilate(webgl_mask, width, height)
dilated_intersection_1px = sum(left and right for left, right in zip(blender_dilated_1px, webgl_dilated_1px))
dilated_union_1px = sum(left or right for left, right in zip(blender_dilated_1px, webgl_dilated_1px))
blender_covered_within_1px = sum(left and right for left, right in zip(blender_mask, webgl_dilated_1px))
webgl_covered_within_1px = sum(left and right for left, right in zip(webgl_mask, blender_dilated_1px))
blender_corners = silhouette_corners(blender_mask, width, height)
webgl_corners = silhouette_corners(webgl_mask, width, height)
corner_deltas = {
    name: [webgl_corners[name][axis] - blender_corners[name][axis] for axis in range(2)]
    for name in blender_corners
} if blender_corners and webgl_corners else None
corner_rmse = math.sqrt(sum(component * component for delta in corner_deltas.values() for component in delta) / 8) if corner_deltas else None

blender_joint = [value for value, enabled in zip(blender_luminance, intersection) if enabled]
webgl_joint = [value for value, enabled in zip(webgl_luminance, intersection) if enabled]
blender_rgb_joint = [pixel[:3] for pixel, enabled in zip(blender_pixels, intersection) if enabled]
webgl_rgb_joint = [pixel[:3] for pixel, enabled in zip(webgl_pixels, intersection) if enabled]
binary_disagreement = sum((left >= 0.5) != (right >= 0.5) for left, right in zip(blender_joint, webgl_joint))
absolute_error = [abs(left - right) for left, right in zip(blender_joint, webgl_joint)]
rgb_absolute_error = [
    abs(left[channel] - right[channel])
    for left, right in zip(blender_rgb_joint, webgl_rgb_joint)
    for channel in range(3)
]
mean_rgb_delta = [
    (
        sum(pixel[channel] for pixel in webgl_rgb_joint)
        - sum(pixel[channel] for pixel in blender_rgb_joint)
    ) / len(blender_rgb_joint)
    for channel in range(3)
] if blender_rgb_joint else None

block_size = 32
block_blender = []
block_webgl = []
for y0 in range(0, height, block_size):
    for x0 in range(0, width, block_size):
        indexes = []
        for y in range(y0, min(y0 + block_size, height)):
            for x in range(x0, min(x0 + block_size, width)):
                index = y * width + x
                if intersection[index]:
                    indexes.append(index)
        if len(indexes) < block_size:
            continue
        block_blender.append(sum(blender_luminance[index] for index in indexes) / len(indexes))
        block_webgl.append(sum(webgl_luminance[index] for index in indexes) / len(indexes))

comparison = {
    "captures": {
        "blender": os.path.basename(blender_path),
        "webgl": os.path.basename(webgl_path),
        "resolution": [width, height],
        "alignment": "same square orthographic camera direction and 1.45 framing scale",
        "webgl_background_key": f"#{webgl_background_hex.lower()}",
        "comparison_composite": "Blender straight-alpha capture composited over the WebGL key in scene-linear space",
        "key_tolerance": webgl_key_tolerance,
        "blender_alpha_gt_0_5_surface_pixels": sum(blender_alpha_mask),
        "webgl_temporal_samples": webgl_samples,
    },
    "blender": mask_stats(blender_mask, blender_luminance),
    "webgl": mask_stats(webgl_mask, webgl_luminance),
    "comparison": {
        "surface_mask_iou": fraction(intersection_count, union_count),
        "surface_mask_iou_dilated_1px": fraction(dilated_intersection_1px, dilated_union_1px),
        "blender_surface_covered_within_1px_fraction": fraction(blender_covered_within_1px, sum(blender_mask)),
        "webgl_surface_covered_within_1px_fraction": fraction(webgl_covered_within_1px, sum(webgl_mask)),
        "surface_corners": {"blender": blender_corners, "webgl": webgl_corners},
        "surface_corner_deltas_webgl_minus_blender": corner_deltas,
        "surface_corner_rmse_pixels": corner_rmse,
        "intersection_pixels": intersection_count,
        "pixel_rgb_mae": sum(rgb_absolute_error) / len(rgb_absolute_error) if rgb_absolute_error else None,
        "mean_rgb_delta": mean_rgb_delta,
        "pixel_luminance_mae": sum(absolute_error) / len(absolute_error) if absolute_error else None,
        "pixel_luminance_correlation": correlation(blender_joint, webgl_joint),
        "binary_mask_disagreement_fraction": fraction(binary_disagreement, len(blender_joint)),
        "macro_block_size": block_size,
        "macro_block_count": len(block_blender),
        "macro_luminance_mae": sum(abs(a - b) for a, b in zip(block_blender, block_webgl)) / len(block_blender) if block_blender else None,
        "macro_luminance_correlation": correlation(block_blender, block_webgl),
        "black_fraction_delta": mask_stats(webgl_mask, webgl_luminance)["black_fraction"] - mask_stats(blender_mask, blender_luminance)["black_fraction"],
        "mean_luminance_delta": mask_stats(webgl_mask, webgl_luminance)["mean_luminance"] - mask_stats(blender_mask, blender_luminance)["mean_luminance"],
    },
    "interpretation": "The transparent Blender capture is composited over the same segmentation key as WebGL before applying one shared key-distance threshold. This compares equivalent antialiased coverage instead of an alpha>0.5 Blender mask against a looser WebGL color-key mask. The aligned silhouette validates the capture context, but luminance occupancy, correlation, and pixel disagreement determine whether the authored WebGL material is visually equivalent. Renderer lighting, environment, tone mapping, texture filtering, and procedural implementations may remain as residuals.",
}
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(comparison, handle, indent=2)
print(f"STIPPLER_SHADER_COMPARE_OK {out_path} {json.dumps(comparison['comparison'], sort_keys=True)}")
