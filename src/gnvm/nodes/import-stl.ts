import { Geometry, Mesh } from "../geometry";
import { embeddedStlPayloadOf } from "../import-stl-payload";
import { reg } from "../registry";

export class UnsupportedImportStlError extends Error {
  constructor(nodeName: string, malformed: boolean) {
    super(
      malformed
        ? `Import STL node "${nodeName}" has an invalid embedded STL payload`
        : `Import STL node "${nodeName}" has no embedded STL payload; re-extract while its authored file is available`,
    );
    this.name = "UnsupportedImportStlError";
  }
}

reg("GeometryNodeImportSTL", (api) => {
  const payload = embeddedStlPayloadOf(api.node);
  if (!payload)
    throw new UnsupportedImportStlError(api.node.name, "embedded_stl" in api.node);

  const geometry = new Geometry();
  const mesh = new Mesh();
  mesh.positions = payload.positions.map((position) => [...position]);
  mesh.faces = payload.faces.map((face) => [...face]);
  mesh.faceMaterial = mesh.faces.map(() => 0);
  mesh.materialSlots = [null];
  geometry.mesh = mesh;
  return { Mesh: geometry };
});
