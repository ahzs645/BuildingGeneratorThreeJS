/**
 * A small, deterministic position-based solver for a rectangular cloth lattice.
 *
 * The solver is deliberately geometry-library agnostic. Callers supply source
 * positions (the undeformed lattice), optional starting positions, and contact
 * targets. Structural constraints preserve source edge lengths while bend
 * constraints resist sharp changes between three consecutive grid vertices.
 */

export type ClothPoint = readonly [x: number, y: number, z: number];

export type ClothPositions = ArrayLike<number> | readonly ClothPoint[];

export interface ClothContact {
  index: number;
  position: ClothPoint;
}

export interface ClothLatticeRelaxationOptions {
  columns: number;
  rows: number;
  /** Undeformed positions used to calculate rest lengths and rest curvature. */
  sourcePositions: ClothPositions;
  /** Positions to relax. Defaults to a copy of `sourcePositions`. */
  initialPositions?: ClothPositions;
  /** Vertices held at their initial positions throughout the solve. */
  pinnedIndices?: readonly number[];
  /** Vertices held at explicit surface/contact positions throughout the solve. */
  contacts?: readonly ClothContact[];
  /** Number of structural edge-length passes. Defaults to 12. */
  stretchIterations?: number;
  /** Per-pass structural correction in the inclusive range 0..1. Defaults to 1. */
  stretchStrength?: number;
  /** Number of bend passes. Defaults to `stretchIterations`. */
  bendIterations?: number;
  /** Per-pass bend correction in the inclusive range 0..1. Defaults to 0. */
  bendStrength?: number;
}

export interface ClothLatticeRelaxationResult {
  /** Packed xyz positions, ready for a Three.js BufferAttribute. */
  positions: Float32Array;
  /** One for contact/pinned vertices and zero for free vertices. */
  pinned: Uint8Array;
  /** Largest absolute structural edge-length error after relaxation. */
  maxStretchError: number;
}

interface StructuralConstraint {
  a: number;
  b: number;
  restLength: number;
}

interface BendConstraint {
  a: number;
  b: number;
  c: number;
  restOffsetX: number;
  restOffsetY: number;
  restOffsetZ: number;
}

function assertGridDimension(value: number, name: "columns" | "rows"): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertIterationCount(value: number, name: "stretchIterations" | "bendIterations"): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertStrength(value: number, name: "stretchStrength" | "bendStrength"): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function assertVertexIndex(index: number, vertexCount: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
    throw new RangeError(`${label} index ${index} is outside 0..${vertexCount - 1}`);
  }
}

function unpackPositions(input: ClothPositions, vertexCount: number, label: string): Float64Array {
  const expectedComponentCount = vertexCount * 3;
  const output = new Float64Array(expectedComponentCount);
  const first = input.length > 0 ? input[0] : undefined;

  if (Array.isArray(first)) {
    const tuples = input as readonly ClothPoint[];
    if (tuples.length !== vertexCount) {
      throw new RangeError(`${label} must contain exactly ${vertexCount} xyz tuples`);
    }
    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      const tuple = tuples[vertexIndex];
      if (!tuple || tuple.length !== 3) {
        throw new RangeError(`${label}[${vertexIndex}] must be an xyz tuple`);
      }
      const offset = vertexIndex * 3;
      output[offset] = tuple[0];
      output[offset + 1] = tuple[1];
      output[offset + 2] = tuple[2];
    }
  } else {
    const packed = input as ArrayLike<number>;
    if (packed.length !== expectedComponentCount) {
      throw new RangeError(`${label} must contain exactly ${expectedComponentCount} xyz components`);
    }
    for (let componentIndex = 0; componentIndex < expectedComponentCount; componentIndex += 1) {
      output[componentIndex] = packed[componentIndex];
    }
  }

  for (let componentIndex = 0; componentIndex < output.length; componentIndex += 1) {
    if (!Number.isFinite(output[componentIndex])) {
      throw new TypeError(`${label} contains a non-finite component at index ${componentIndex}`);
    }
  }
  return output;
}

function distance(positions: Float64Array, a: number, b: number): number {
  const aOffset = a * 3;
  const bOffset = b * 3;
  return Math.hypot(
    positions[bOffset] - positions[aOffset],
    positions[bOffset + 1] - positions[aOffset + 1],
    positions[bOffset + 2] - positions[aOffset + 2],
  );
}

function buildStructuralConstraints(
  columns: number,
  rows: number,
  source: Float64Array,
): StructuralConstraint[] {
  const constraints: StructuralConstraint[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (column + 1 < columns) {
        constraints.push({ a: index, b: index + 1, restLength: distance(source, index, index + 1) });
      }
      if (row + 1 < rows) {
        constraints.push({ a: index, b: index + columns, restLength: distance(source, index, index + columns) });
      }
    }
  }
  return constraints;
}

function makeBendConstraint(source: Float64Array, a: number, b: number, c: number): BendConstraint {
  const aOffset = a * 3;
  const bOffset = b * 3;
  const cOffset = c * 3;
  return {
    a,
    b,
    c,
    restOffsetX: source[bOffset] - (source[aOffset] + source[cOffset]) * 0.5,
    restOffsetY: source[bOffset + 1] - (source[aOffset + 1] + source[cOffset + 1]) * 0.5,
    restOffsetZ: source[bOffset + 2] - (source[aOffset + 2] + source[cOffset + 2]) * 0.5,
  };
}

function buildBendConstraints(columns: number, rows: number, source: Float64Array): BendConstraint[] {
  const constraints: BendConstraint[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 1; column + 1 < columns; column += 1) {
      const center = row * columns + column;
      constraints.push(makeBendConstraint(source, center - 1, center, center + 1));
    }
  }
  for (let column = 0; column < columns; column += 1) {
    for (let row = 1; row + 1 < rows; row += 1) {
      const center = row * columns + column;
      constraints.push(makeBendConstraint(source, center - columns, center, center + columns));
    }
  }
  return constraints;
}

function solveStructuralConstraint(
  positions: Float64Array,
  pinned: Uint8Array,
  constraint: StructuralConstraint,
  strength: number,
): void {
  const { a, b, restLength } = constraint;
  const aOffset = a * 3;
  const bOffset = b * 3;
  const dx = positions[bOffset] - positions[aOffset];
  const dy = positions[bOffset + 1] - positions[aOffset + 1];
  const dz = positions[bOffset + 2] - positions[aOffset + 2];
  const currentLength = Math.hypot(dx, dy, dz);
  if (currentLength <= Number.EPSILON || strength === 0) return;

  const aWeight = pinned[a] ? 0 : 1;
  const bWeight = pinned[b] ? 0 : 1;
  const totalWeight = aWeight + bWeight;
  if (totalWeight === 0) return;

  const correctionScale = ((currentLength - restLength) / currentLength) * strength;
  const aScale = correctionScale * (aWeight / totalWeight);
  const bScale = correctionScale * (bWeight / totalWeight);
  positions[aOffset] += dx * aScale;
  positions[aOffset + 1] += dy * aScale;
  positions[aOffset + 2] += dz * aScale;
  positions[bOffset] -= dx * bScale;
  positions[bOffset + 1] -= dy * bScale;
  positions[bOffset + 2] -= dz * bScale;
}

function solveBendConstraint(
  positions: Float64Array,
  pinned: Uint8Array,
  constraint: BendConstraint,
  strength: number,
): void {
  if (strength === 0) return;
  const { a, b, c } = constraint;
  const aWeight = pinned[a] ? 0 : 1;
  const bWeight = pinned[b] ? 0 : 1;
  const cWeight = pinned[c] ? 0 : 1;
  // Gradient magnitudes are 0.5, 1, and 0.5 for a, b, and c.
  const denominator = aWeight * 0.25 + bWeight + cWeight * 0.25;
  if (denominator === 0) return;

  const aOffset = a * 3;
  const bOffset = b * 3;
  const cOffset = c * 3;
  const errorX = positions[bOffset]
    - (positions[aOffset] + positions[cOffset]) * 0.5
    - constraint.restOffsetX;
  const errorY = positions[bOffset + 1]
    - (positions[aOffset + 1] + positions[cOffset + 1]) * 0.5
    - constraint.restOffsetY;
  const errorZ = positions[bOffset + 2]
    - (positions[aOffset + 2] + positions[cOffset + 2]) * 0.5
    - constraint.restOffsetZ;
  const correctionScale = strength / denominator;
  const aScale = aWeight * 0.5 * correctionScale;
  const bScale = bWeight * correctionScale;
  const cScale = cWeight * 0.5 * correctionScale;

  positions[aOffset] += errorX * aScale;
  positions[aOffset + 1] += errorY * aScale;
  positions[aOffset + 2] += errorZ * aScale;
  positions[bOffset] -= errorX * bScale;
  positions[bOffset + 1] -= errorY * bScale;
  positions[bOffset + 2] -= errorZ * bScale;
  positions[cOffset] += errorX * cScale;
  positions[cOffset + 1] += errorY * cScale;
  positions[cOffset + 2] += errorZ * cScale;
}

function maximumStretchError(positions: Float64Array, constraints: readonly StructuralConstraint[]): number {
  let maximum = 0;
  for (const constraint of constraints) {
    maximum = Math.max(maximum, Math.abs(distance(positions, constraint.a, constraint.b) - constraint.restLength));
  }
  return maximum;
}

/**
 * Relax a rectangular lattice without mutating any supplied position buffer.
 */
export function relaxClothLattice(
  options: ClothLatticeRelaxationOptions,
): ClothLatticeRelaxationResult {
  const { columns, rows } = options;
  assertGridDimension(columns, "columns");
  assertGridDimension(rows, "rows");
  const vertexCount = columns * rows;
  const stretchIterations = options.stretchIterations ?? 12;
  const stretchStrength = options.stretchStrength ?? 1;
  const bendIterations = options.bendIterations ?? stretchIterations;
  const bendStrength = options.bendStrength ?? 0;
  assertIterationCount(stretchIterations, "stretchIterations");
  assertIterationCount(bendIterations, "bendIterations");
  assertStrength(stretchStrength, "stretchStrength");
  assertStrength(bendStrength, "bendStrength");

  const source = unpackPositions(options.sourcePositions, vertexCount, "sourcePositions");
  const positions = options.initialPositions
    ? unpackPositions(options.initialPositions, vertexCount, "initialPositions")
    : source.slice();
  const pinned = new Uint8Array(vertexCount);

  for (const index of options.pinnedIndices ?? []) {
    assertVertexIndex(index, vertexCount, "Pinned vertex");
    pinned[index] = 1;
  }

  const contactIndices = new Set<number>();
  for (const contact of options.contacts ?? []) {
    assertVertexIndex(contact.index, vertexCount, "Contact vertex");
    if (contactIndices.has(contact.index)) {
      throw new Error(`Contact vertex index ${contact.index} was supplied more than once`);
    }
    contactIndices.add(contact.index);
    const [x, y, z] = contact.position;
    if (![x, y, z].every(Number.isFinite)) {
      throw new TypeError(`Contact vertex ${contact.index} contains a non-finite position`);
    }
    const offset = contact.index * 3;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    pinned[contact.index] = 1;
  }

  const structuralConstraints = buildStructuralConstraints(columns, rows, source);
  const bendConstraints = bendStrength > 0 ? buildBendConstraints(columns, rows, source) : [];
  const passCount = Math.max(stretchIterations, bendIterations);
  for (let pass = 0; pass < passCount; pass += 1) {
    if (pass < stretchIterations) {
      for (const constraint of structuralConstraints) {
        solveStructuralConstraint(positions, pinned, constraint, stretchStrength);
      }
    }
    if (pass < bendIterations) {
      for (const constraint of bendConstraints) {
        solveBendConstraint(positions, pinned, constraint, bendStrength);
      }
    }
  }

  return {
    positions: Float32Array.from(positions),
    pinned,
    maxStretchError: maximumStretchError(positions, structuralConstraints),
  };
}
