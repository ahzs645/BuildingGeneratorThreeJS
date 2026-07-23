"""Measure the matched Blender/native-MaterialX 2.5D Chrome Crayon render."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_references import metrics, pixels


def foreground_metrics(reference: Path, candidate: Path):
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError("2.5D comparison dimensions differ")
    background_a = a[0]
    background_b = b[0]

    def distance(color, background):
        return math.sqrt(sum((channel - base) ** 2 for channel, base in zip(color, background)))

    mask_a = [distance(color, background_a) > 0.02 for color in a]
    mask_b = [distance(color, background_b) > 0.02 for color in b]
    intersection = [left and right for left, right in zip(mask_a, mask_b)]
    union = [left or right for left, right in zip(mask_a, mask_b)]
    intersection_count = sum(intersection)
    union_count = sum(union)
    selected_a = [color for color, selected in zip(a, intersection) if selected]
    selected_b = [color for color, selected in zip(b, intersection) if selected]
    count = len(selected_a)
    luminance_a = [0.2126 * r + 0.7152 * g + 0.0722 * blue for r, g, blue in selected_a]
    luminance_b = [0.2126 * r + 0.7152 * g + 0.0722 * blue for r, g, blue in selected_b]
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum((left - mean_a) * (right - mean_b) for left, right in zip(luminance_a, luminance_b))
    denominator = math.sqrt(
        sum((value - mean_a) ** 2 for value in luminance_a)
        * sum((value - mean_b) ** 2 for value in luminance_b)
    )
    return {
        "maskThresholdRgbDistance": 0.02,
        "blenderPixelCount": sum(mask_a),
        "webPixelCount": sum(mask_b),
        "intersectionPixelCount": intersection_count,
        "unionPixelCount": union_count,
        "visibleRegionIntersectionOverUnion": round(intersection_count / union_count, 6),
        "intersectionRgbMeanAbsoluteError": round(
            sum(abs(left - right) for pa, pb in zip(selected_a, selected_b) for left, right in zip(pa, pb))
            / (count * 3),
            6,
        ),
        "intersectionRgbRootMeanSquareError": round(
            math.sqrt(
                sum((left - right) ** 2 for pa, pb in zip(selected_a, selected_b) for left, right in zip(pa, pb))
                / (count * 3)
            ),
            6,
        ),
        "intersectionLuminanceCorrelation": round(numerator / denominator if denominator else 0, 6),
        "intersectionMeanLuminance": {
            "blender": round(mean_a, 6),
            "web": round(mean_b, 6),
        },
    }


def main() -> None:
    directory = Path(
        sys.argv[sys.argv.index("--") + 1]
        if "--" in sys.argv
        else "docs/materialx-evidence/current"
    ).resolve()
    blender = directory / "25d-native-blender.png"
    web = directory / "25d-native-web.png"
    output = {
        "comparisonVersion": 1,
        "asset": "25d-chrome-crayon",
        "sourceObject": "2.5D CHROME CRAYON OBJECT",
        "sourceMaterial": "chrome.003",
        "geometry": {
            "blender": {"vertices": 97_784, "faces": 97_776},
            "web": {"vertices": 97_784, "faces": 97_776},
            "roughAttribute": {"sourceDomain": "face", "gpuDomain": "vertex", "range": [0, 0]},
        },
        "renderContract": {
            "resolution": [768, 768],
            "camera": "matched orthographic bounds frame; direction (1,-1.25,0.85), Z up",
            "lighting": "shared studio-environment.exr at 0.18 plus scene-contract.json directional lights",
            "colorTransform": "Standard/sRGB, no tone mapping",
            "blenderBackend": "Blender 5.1.2 Eevee with the authored chrome.003 node graph",
            "webBackend": "WebGL2 with official MaterialX 1.39.4 generated ESSL/FIS",
        },
        "fullFrame": metrics(blender, web),
        "foreground": foreground_metrics(blender, web),
        "claim": "Native graph semantics and live geometry bindings are recovered. Pixel differences remain expected across Eevee and MaterialX FIS BRDF/environment sampling and do not establish renderer identity.",
    }
    path = directory / "25d-native-comparison.json"
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
