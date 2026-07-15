#include "btConvexHullComputer.h"

static btConvexHullComputer hull;

extern "C" {

int hull_compute(const float *coords, const int count) {
  hull.compute(coords, sizeof(float) * 3, count, 0, 0);
  return hull.vertices.size();
}

int hull_num_vertices() { return hull.vertices.size(); }

int hull_vertex_original_index(const int vertex) {
  return hull.original_vertex_index[vertex];
}

int hull_num_faces() { return hull.faces.size(); }

int hull_face_size(const int face) {
  const auto *start = &hull.edges[hull.faces[face]];
  const auto *edge = start;
  int count = 0;
  do {
    count++;
    edge = edge->getNextEdgeOfFace();
  } while (edge != start);
  return count;
}

int hull_face_vertex(const int face, const int corner) {
  const auto *edge = &hull.edges[hull.faces[face]];
  for (int index = 0; index < corner; index++) {
    edge = edge->getNextEdgeOfFace();
  }
  return edge->getSourceVertex();
}

}
