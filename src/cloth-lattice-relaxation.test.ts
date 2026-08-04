import assert from "node:assert/strict";
import test from "node:test";
import { relaxClothLattice, type ClothPoint } from "./cloth-lattice-relaxation";

const near = (actual: number, expected: number, tolerance = 1e-5): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);
};

const pointAt = (positions: ArrayLike<number>, index: number): ClothPoint => {
  const offset = index * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
};

test("accepts tuple source positions and returns packed positions without mutating input", () => {
  const source: ClothPoint[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ];
  const result = relaxClothLattice({ columns: 2, rows: 2, sourcePositions: source });

  assert.ok(result.positions instanceof Float32Array);
  assert.deepEqual([...result.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  assert.deepEqual(source[0], [0, 0, 0]);
  assert.equal(result.maxStretchError, 0);
});

test("contact vertices stay at exact surface targets while free vertices relax", () => {
  const result = relaxClothLattice({
    columns: 3,
    rows: 1,
    sourcePositions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
    initialPositions: [0, 0, 0, 1, 1.4, 0, 2, 0, 0],
    contacts: [
      { index: 0, position: [0, 0, 0] },
      { index: 2, position: [2, 0, 0] },
    ],
    stretchIterations: 40,
    stretchStrength: 1,
    bendIterations: 20,
    bendStrength: 0.35,
  });

  assert.deepEqual(pointAt(result.positions, 0), [0, 0, 0]);
  assert.deepEqual(pointAt(result.positions, 2), [2, 0, 0]);
  near(result.positions[4], 0, 1e-4);
  assert.deepEqual([...result.pinned], [1, 0, 1]);
  assert.ok(result.maxStretchError < 1e-4);
});

test("pinned indices retain their initial positions instead of snapping to source", () => {
  const result = relaxClothLattice({
    columns: 2,
    rows: 1,
    sourcePositions: [0, 0, 0, 1, 0, 0],
    initialPositions: [3, 2, 1, 7, 2, 1],
    pinnedIndices: [0],
    stretchIterations: 8,
  });

  assert.deepEqual(pointAt(result.positions, 0), [3, 2, 1]);
  near(result.positions[3], 4);
  near(result.positions[4], 2);
  near(result.positions[5], 1);
});

test("stretch strength zero leaves free starting positions unchanged", () => {
  const initial = [0, 0, 0, 8, 2, -1];
  const result = relaxClothLattice({
    columns: 2,
    rows: 1,
    sourcePositions: [0, 0, 0, 1, 0, 0],
    initialPositions: initial,
    stretchIterations: 20,
    stretchStrength: 0,
  });

  assert.deepEqual([...result.positions], initial);
});

test("bend smoothing removes a sharp middle kink while respecting pinned ends", () => {
  const result = relaxClothLattice({
    columns: 3,
    rows: 1,
    sourcePositions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
    initialPositions: [0, 0, 0, 1, 2, 0, 2, 0, 0],
    pinnedIndices: [0, 2],
    stretchIterations: 0,
    bendIterations: 1,
    bendStrength: 1,
  });

  assert.deepEqual(pointAt(result.positions, 0), [0, 0, 0]);
  assert.deepEqual(pointAt(result.positions, 1), [1, 0, 0]);
  assert.deepEqual(pointAt(result.positions, 2), [2, 0, 0]);
});

test("the solver is deterministic for identical inputs", () => {
  const options = {
    columns: 2,
    rows: 2,
    sourcePositions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    initialPositions: [0, 0, 1, 1.4, 0, 0, 0, 1.2, 0, 1.2, 1.2, -0.4],
    contacts: [{ index: 0, position: [0, 0, 1] as ClothPoint }],
    stretchIterations: 16,
    stretchStrength: 0.75,
    bendIterations: 8,
    bendStrength: 0.2,
  };

  const first = relaxClothLattice(options);
  const second = relaxClothLattice(options);
  assert.deepEqual(first.positions, second.positions);
  assert.equal(first.maxStretchError, second.maxStretchError);
});

test("invalid topology, buffers, contacts, and solver parameters fail loudly", () => {
  assert.throws(
    () => relaxClothLattice({ columns: 0, rows: 1, sourcePositions: [] }),
    /columns must be a positive integer/,
  );
  assert.throws(
    () => relaxClothLattice({ columns: 2, rows: 1, sourcePositions: [0, 0, 0] }),
    /exactly 6 xyz components/,
  );
  assert.throws(
    () => relaxClothLattice({
      columns: 1,
      rows: 1,
      sourcePositions: [0, 0, 0],
      contacts: [{ index: 1, position: [0, 0, 0] }],
    }),
    /outside 0..0/,
  );
  assert.throws(
    () => relaxClothLattice({
      columns: 1,
      rows: 1,
      sourcePositions: [0, 0, 0],
      stretchStrength: 1.1,
    }),
    /stretchStrength must be between 0 and 1/,
  );
});
