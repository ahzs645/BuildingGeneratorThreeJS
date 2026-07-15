"""Compare aligned Blender and WebGL Image Pixel Stippler captures.

Usage:
  blender --background --python tools/compare_stippler_shader_masks.py -- \
    BLENDER.png WEBGL.png OUT.json

The Blender capture must have a transparent background. The opt-in WebGL
``capture=stippler-shader`` route uses #ff00ff as a segmentation background.
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


def load(path):
    image = bpy.data.images.load(path, check_existing=False)
    width, height = image.size
    values = list(image.pixels)
    pixels = [tuple(values[offset:offset + 4]) for offset in range(0, len(values), 4)]
    return width, height, pixels


def luminance(pixel):
    return 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]


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


width, height, blender_pixels = load(blender_path)
webgl_width, webgl_height, webgl_pixels = load(webgl_path)
if (width, height) != (webgl_width, webgl_height):
    raise RuntimeError(f"capture sizes differ: {(width, height)} != {(webgl_width, webgl_height)}")

blender_mask = [pixel[3] > 0.5 for pixel in blender_pixels]
webgl_mask = [not (pixel[0] > 0.8 and pixel[1] < 0.3 and pixel[2] > 0.8) for pixel in webgl_pixels]
blender_luminance = [luminance(pixel) for pixel in blender_pixels]
webgl_luminance = [luminance(pixel) for pixel in webgl_pixels]
intersection = [left and right for left, right in zip(blender_mask, webgl_mask)]
union = [left or right for left, right in zip(blender_mask, webgl_mask)]
intersection_count = sum(intersection)
union_count = sum(union)

blender_joint = [value for value, enabled in zip(blender_luminance, intersection) if enabled]
webgl_joint = [value for value, enabled in zip(webgl_luminance, intersection) if enabled]
binary_disagreement = sum((left >= 0.5) != (right >= 0.5) for left, right in zip(blender_joint, webgl_joint))
absolute_error = [abs(left - right) for left, right in zip(blender_joint, webgl_joint)]

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
    },
    "blender": mask_stats(blender_mask, blender_luminance),
    "webgl": mask_stats(webgl_mask, webgl_luminance),
    "comparison": {
        "surface_mask_iou": fraction(intersection_count, union_count),
        "intersection_pixels": intersection_count,
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
    "interpretation": "The aligned silhouette and visible image structure validate the capture context, but the occupancy, macro correlation, and pixel disagreement do not establish shader parity. Residual differences include viewport filtering/sampling and may include Generated-coordinate or renderer-specific hash behavior.",
}
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(comparison, handle, indent=2)
print(f"STIPPLER_SHADER_COMPARE_OK {out_path} {json.dumps(comparison['comparison'], sort_keys=True)}")
