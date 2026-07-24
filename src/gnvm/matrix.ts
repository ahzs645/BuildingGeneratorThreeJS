import type { Vec3 } from "./core";

export type Matrix4Rows = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

const IDENTITY_ROWS: Matrix4Rows = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function cloneRows(rows: number[][]): Matrix4Rows {
  return [0, 1, 2, 3].map((row) =>
    [0, 1, 2, 3].map((column) =>
      Number(rows[row]?.[column] ?? (row === column ? 1 : 0)),
    ),
  ) as Matrix4Rows;
}

/**
 * Matrix sockets are concrete values, not fields or renderable geometry.
 * Keeping them branded prevents the evaluator from mistaking a nested array
 * for a vector socket or a generic datablock reference.
 */
export class MatrixValue {
  readonly kind = "gnvm-matrix";
  readonly rows: Matrix4Rows;

  constructor(rows: number[][] = IDENTITY_ROWS) {
    this.rows = cloneRows(rows);
  }

  clone(): MatrixValue {
    return new MatrixValue(this.rows);
  }
}

export function identityMatrix(): MatrixValue {
  return new MatrixValue(IDENTITY_ROWS);
}

export function matrixFromTRS(
  translation: Vec3,
  rotation: Vec3,
  scale: Vec3,
): MatrixValue {
  const [x, y, z] = rotation;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  // Blender's XYZ Euler convention composes Rz * Ry * Rx. Scale is applied
  // to the basis columns before translation.
  const rotationRows = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  return new MatrixValue([
    [rotationRows[0][0] * scale[0], rotationRows[0][1] * scale[1], rotationRows[0][2] * scale[2], translation[0]],
    [rotationRows[1][0] * scale[0], rotationRows[1][1] * scale[1], rotationRows[1][2] * scale[2], translation[1]],
    [rotationRows[2][0] * scale[0], rotationRows[2][1] * scale[1], rotationRows[2][2] * scale[2], translation[2]],
    [0, 0, 0, 1],
  ]);
}

export function multiplyMatrices(left: MatrixValue, right: MatrixValue): MatrixValue {
  const a = left.rows;
  const b = right.rows;
  return new MatrixValue([0, 1, 2, 3].map((row) =>
    [0, 1, 2, 3].map((column) =>
      a[row][0] * b[0][column]
      + a[row][1] * b[1][column]
      + a[row][2] * b[2][column]
      + a[row][3] * b[3][column],
    ),
  ));
}

export function invertMatrix(matrix: MatrixValue): {
  matrix: MatrixValue;
  invertible: boolean;
} {
  const augmented = matrix.rows.map((row, index) => [
    ...row,
    ...IDENTITY_ROWS[index],
  ]);
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++)
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-12)
      return { matrix: identityMatrix(), invertible: false };
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = 0; entry < 8; entry++) augmented[column][entry] /= divisor;
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = 0; entry < 8; entry++)
        augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return {
    matrix: new MatrixValue(augmented.map((row) => row.slice(4))),
    invertible: true,
  };
}

export function decomposeMatrix(matrix: MatrixValue): {
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
} {
  const rows = matrix.rows;
  const translation: Vec3 = [rows[0][3], rows[1][3], rows[2][3]];
  const axes = [0, 1, 2].map((column) =>
    [rows[0][column], rows[1][column], rows[2][column]] as Vec3);
  const scale = axes.map((axis) => Math.hypot(...axis)) as Vec3;
  const determinant =
    rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
    - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
    + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]);
  if (determinant < 0) scale[0] = -scale[0];
  const normalized = axes.map((axis, column) => {
    const divisor = Math.abs(scale[column]) > 1e-12 ? scale[column] : 1;
    return axis.map((value) => value / divisor) as Vec3;
  });
  const sinY = Math.max(-1, Math.min(1, -normalized[0][2]));
  const y = Math.asin(sinY);
  const rotation: Vec3 = Math.abs(sinY) < .9999999
    ? [
        Math.atan2(normalized[1][2], normalized[2][2]),
        y,
        Math.atan2(normalized[0][1], normalized[0][0]),
      ]
    : [Math.atan2(-normalized[2][1], normalized[1][1]), y, 0];
  return { translation, rotation, scale };
}

export function objectTransformMatrix(object: {
  matrix_world?: number[][];
  location?: number[];
  rotation?: number[];
  scale?: number[];
} | undefined): MatrixValue {
  if (object?.matrix_world) return new MatrixValue(object.matrix_world);
  return matrixFromTRS(
    (object?.location?.slice(0, 3) ?? [0, 0, 0]) as Vec3,
    (object?.rotation?.slice(0, 3) ?? [0, 0, 0]) as Vec3,
    (object?.scale?.slice(0, 3) ?? [1, 1, 1]) as Vec3,
  );
}
