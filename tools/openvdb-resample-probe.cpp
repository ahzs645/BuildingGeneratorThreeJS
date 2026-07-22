// Reproduce Blender's FloatGrid -> GridTransformer -> VolumeToMesh boundary.
//
// This diagnostic intentionally links against Blender's bundled OpenVDB so a
// captured GN-VM Volume Cube field can be compared with the exact native
// resampling and meshing implementation used by Blender.
//
// Usage:
//   openvdb-resample-probe INPUT.f32 RX RY RZ BACKGROUND FACTOR THRESHOLD OUT.f32 [xyz|zyx]

#include <openvdb/openvdb.h>
#include <openvdb/tools/Dense.h>
#include <openvdb/tools/GridTransformer.h>
#include <openvdb/tools/VolumeToMesh.h>

#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::uint64_t fnv1a64(const std::vector<float> &values)
{
  std::uint64_t hash = 0xcbf29ce484222325ULL;
  const auto *bytes = reinterpret_cast<const std::uint8_t *>(values.data());
  for (std::size_t i = 0; i < values.size() * sizeof(float); i++) {
    hash ^= bytes[i];
    hash *= 0x100000001b3ULL;
  }
  return hash;
}

}  // namespace

int main(int argc, char **argv)
{
  if (argc != 9 && argc != 10) {
    std::cerr << "usage: openvdb-resample-probe INPUT.f32 RX RY RZ BACKGROUND FACTOR THRESHOLD OUT.f32 [xyz|zyx]\n";
    return 2;
  }
  const std::string input_path = argv[1];
  const int rx = std::stoi(argv[2]), ry = std::stoi(argv[3]), rz = std::stoi(argv[4]);
  const float background = std::stof(argv[5]);
  const float factor = std::stof(argv[6]);
  const float threshold = std::stof(argv[7]);
  const std::string output_path = argv[8];
  const std::string layout = argc == 10 ? argv[9] : "xyz";
  if (layout != "xyz" && layout != "zyx") {
    std::cerr << "layout must be xyz or zyx\n";
    return 2;
  }

  std::vector<float> source(std::size_t(rx) * std::size_t(ry) * std::size_t(rz));
  std::ifstream input(input_path, std::ios::binary);
  input.read(reinterpret_cast<char *>(source.data()), std::streamsize(source.size() * sizeof(float)));
  if (!input || input.peek() != std::ifstream::traits_type::eof()) {
    std::cerr << "failed to read exact source grid size from " << input_path << "\n";
    return 3;
  }

  openvdb::initialize();
  auto grid = openvdb::FloatGrid::create(background);
  grid->setGridClass(openvdb::GRID_FOG_VOLUME);
  // GN-VM diagnostic buffers are X-major (X stride 1). Blender's internal
  // Grid3D field buffer is Z-major and uses LayoutZYX, but both describe the
  // same coordinate grid; LayoutXYZ maps this exported buffer back correctly.
  const openvdb::CoordBBox source_bbox(
      openvdb::Coord(0, 0, 0), openvdb::Coord(rx - 1, ry - 1, rz - 1));
  if (layout == "xyz") {
    openvdb::tools::Dense<float, openvdb::tools::LayoutXYZ> dense(source_bbox, source.data());
    openvdb::tools::copyFromDense(dense, *grid, 0.0f);
  }
  else {
    openvdb::tools::Dense<float, openvdb::tools::LayoutZYX> dense(source_bbox, source.data());
    openvdb::tools::copyFromDense(dense, *grid, 0.0f);
  }

  openvdb::Mat4R matrix;
  matrix.setToScale(openvdb::Vec3d(factor));
  openvdb::tools::GridTransformer transformer(matrix);
  auto resampled = openvdb::FloatGrid::create();
  transformer.transformGrid<openvdb::tools::BoxSampler>(*grid, *resampled);

  std::vector<openvdb::Vec3s> verts;
  std::vector<openvdb::Vec3I> tris;
  std::vector<openvdb::Vec4I> quads;
  openvdb::tools::volumeToMesh(*resampled, verts, tris, quads, threshold, 0.0);

  const openvdb::Coord transformed_max(
      int(std::ceil(double(rx - 1) * double(factor))),
      int(std::ceil(double(ry - 1) * double(factor))),
      int(std::ceil(double(rz - 1) * double(factor))));
  const openvdb::Coord minimum(-2, -2, -2);
  const openvdb::Coord maximum = transformed_max.offsetBy(3);
  const openvdb::Coord dimensions = maximum - minimum + openvdb::Coord(1);
  std::vector<float> sampled(std::size_t(dimensions.x()) * std::size_t(dimensions.y()) * std::size_t(dimensions.z()));
  std::size_t index = 0, active_samples = 0;
  auto accessor = resampled->getConstAccessor();
  for (int z = minimum.z(); z <= maximum.z(); z++) {
    for (int y = minimum.y(); y <= maximum.y(); y++) {
      for (int x = minimum.x(); x <= maximum.x(); x++, index++) {
        const openvdb::Coord coordinate(x, y, z);
        sampled[index] = accessor.getValue(coordinate);
        if (accessor.isValueOn(coordinate)) active_samples++;
      }
    }
  }
  std::ofstream output(output_path, std::ios::binary);
  output.write(reinterpret_cast<const char *>(sampled.data()), std::streamsize(sampled.size() * sizeof(float)));

  const auto active_bbox = resampled->evalActiveVoxelBoundingBox();
  std::cout << std::setprecision(17)
            << "{\n"
            << "  \"source_active_voxels\": " << grid->activeVoxelCount() << ",\n"
            << "  \"source_layout\": \"" << layout << "\",\n"
            << "  \"resampled_active_voxels\": " << resampled->activeVoxelCount() << ",\n"
            << "  \"sampled_active_voxels\": " << active_samples << ",\n"
            << "  \"sample_resolution\": [" << dimensions.x() << ", " << dimensions.y() << ", " << dimensions.z() << "],\n"
            << "  \"sample_origin\": [" << minimum.x() << ", " << minimum.y() << ", " << minimum.z() << "],\n"
            << "  \"active_bbox\": [[" << active_bbox.min().x() << ", " << active_bbox.min().y() << ", " << active_bbox.min().z()
            << "], [" << active_bbox.max().x() << ", " << active_bbox.max().y() << ", " << active_bbox.max().z() << "]],\n"
            << "  \"fnv1a64\": \"" << std::hex << std::setw(16) << std::setfill('0') << fnv1a64(sampled) << std::dec << "\",\n"
            << "  \"verts\": " << verts.size() << ",\n"
            << "  \"tris\": " << tris.size() << ",\n"
            << "  \"quads\": " << quads.size() << ",\n"
            << "  \"faces\": " << tris.size() + quads.size() << "\n"
            << "}\n";
  return 0;
}
