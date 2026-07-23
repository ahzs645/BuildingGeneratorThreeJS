"""Measure the baked Blender and Three validation renders with project metrics."""

from __future__ import annotations

import json
import argparse
import sys
from pathlib import Path

sys.dont_write_bytecode = True
materialx_tools = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(materialx_tools))
from compare_references import metrics
from compare_three_pr33485 import sphere_metrics


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", nargs="?", default="docs/materialx-evidence/baked")
    parser.add_argument("--sweep-dir")
    options = parser.parse_args(argv)
    directory = Path(options.directory).resolve()
    procedural = directory / "noise-bump-procedural-blender.png"
    baked_blender = directory / "noise-bump-baked-blender.png"
    baked_web = directory / "noise-bump-baked-web.png"
    output = {
        "comparisonVersion": 1,
        "bakeSemanticValidation": {
            "fullFrame": metrics(procedural, baked_blender),
            "sphereRegion": sphere_metrics(procedural, baked_blender),
        },
        "rendererValidation": {
            "fullFrame": metrics(procedural, baked_web),
            "sphereRegion": sphere_metrics(procedural, baked_web),
        },
        "interpretation": (
            "The Blender-to-Blender comparison isolates bake semantics. The Blender-to-Three "
            "comparison also contains the known Eevee/Three BRDF, direct-light, shadow, and "
            "environment-filtering differences and must not be read as a texture-bake error."
        ),
    }
    if options.sweep_dir:
        sweep_dir = Path(options.sweep_dir).resolve()
        output["manualPbrNormalScaleSweep"] = {
            candidate.stem.removeprefix("baked-scale-"): sphere_metrics(procedural, candidate)
            for candidate in sorted(sweep_dir.glob("baked-scale-*.png"))
        }
        output["sweepInterpretation"] = (
            "The optional sweep uses a manual MeshPhysicalMaterial diagnostic, not the final "
            "MaterialXLoader capture. It shows that normal scale/sign tuning does not resolve "
            "the dominant Eevee/Three lighting and BRDF difference."
        )
    path = directory / "web-comparison.json"
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
