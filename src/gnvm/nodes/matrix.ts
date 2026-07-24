import { Field } from "../core";
import {
  decomposeMatrix,
  identityMatrix,
  invertMatrix,
  MatrixValue,
} from "../matrix";
import { reg } from "../registry";

reg("FunctionNodeInvertMatrix", (api) => {
  const input = api.input("Matrix");
  const result = invertMatrix(input instanceof MatrixValue ? input : identityMatrix());
  return {
    Matrix: result.matrix,
    Invertible: Field.of(result.invertible ? 1 : 0),
  };
});

reg("FunctionNodeSeparateTransform", (api) => {
  const input = api.input("Transform");
  const parts = decomposeMatrix(input instanceof MatrixValue ? input : identityMatrix());
  return {
    Translation: Field.of(parts.translation),
    Rotation: Field.of(parts.rotation),
    Scale: Field.of(parts.scale),
  };
});
