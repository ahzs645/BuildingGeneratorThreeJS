import { Field } from "../core";
import { reg } from "../registry";

reg("GeometryNodeInputMaterialIndex", () => ({
  "Material Index": Field.perElem((index, context) =>
    context.materialIndex?.(index) ?? 0).tagged("FACE"),
}));

reg("GeometryNodeMaterialSelection", (api) => {
  const material = api.ref("Material")?.name ?? null;
  return {
    Selection: Field.perElem((index, context) =>
      context.materialName?.(index) === material ? 1 : 0).tagged("FACE", "BOOLEAN"),
  };
});
