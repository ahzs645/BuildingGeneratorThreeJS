#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="${TMPDIR:-/tmp}/blender-bullet-hull-source"
blender_commit="ec6e62d40fa9e9d1bea33ad5d00148c99a4f0832"

if ! command -v em++ >/dev/null; then
  echo "Emscripten em++ is required to rebuild the Bullet hull module." >&2
  exit 1
fi

rm -rf "$source_dir"
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/blender/blender.git "$source_dir"
git -C "$source_dir" sparse-checkout init --cone
git -C "$source_dir" sparse-checkout set extern/bullet2/src/LinearMath
git -C "$source_dir" fetch --depth 1 origin "$blender_commit"
git -C "$source_dir" checkout --detach FETCH_HEAD

linear_math="$source_dir/extern/bullet2/src/LinearMath"
em++ -std=c++17 -O3 -flto -DBT_USE_DOUBLE_PRECISION \
  -I"$linear_math" \
  "$repo_root/tools/bullet-hull/blender_bullet_hull.cpp" \
  "$linear_math/btConvexHullComputer.cpp" \
  "$linear_math/btAlignedAllocator.cpp" \
  -o "$repo_root/src/gnvm/vendor/blender-bullet-hull.js" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createBulletHullModule \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s SINGLE_FILE=1 \
  -s 'EXPORTED_FUNCTIONS=["_malloc","_free","_hull_compute","_hull_num_vertices","_hull_vertex_original_index","_hull_num_faces","_hull_face_size","_hull_face_vertex"]' \
  -s 'EXPORTED_RUNTIME_METHODS=["HEAPF32"]'
