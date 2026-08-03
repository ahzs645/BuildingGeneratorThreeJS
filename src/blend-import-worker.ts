import {
  GEOMETRY_PROBE,
  runGeometryTarget,
  toTriSoup,
  setDenseSdfSampleBudget,
  type Dump,
  type RunNodeGroupOptions,
  type TriSoup,
} from "./gnvm/index";

type EvaluationFields = {
  id: number;
  object?: string;
  group?: string;
  modifierIndex?: number;
  targetKind?: "object" | "group";
  overrides: Record<string, unknown>;
  frame?: number;
  volumeSampleBudget?: number;
  seed?: RunNodeGroupOptions["seed"];
  geometryInput?: string;
  output?: string;
  curves?: { points: number[][]; cyclic: boolean; tilts?: number[] }[];
  collectionSpheres?: {
    collection: string;
    spheres: { position: [number, number, number]; radius: number }[];
    relativeToObject?: string;
  };
  collectionCylinders?: {
    collection: string;
    cylinders: {
      position: [number, number, number];
      direction: [number, number, number];
      radius: number;
      length: number;
    }[];
    relativeToObject?: string;
  };
  probe?: { group: string; node: string; socket?: string };
};

/** Original one-shot shape: the full dump travels with every request. */
type InlineRequest = EvaluationFields & { kind?: undefined; dump: Dump };

/** Cache a dump worker-side so later evaluations can skip the ~10 MB clone. */
type InstallRequest = { kind: "install"; installId: string; dump: Dump };

/** Evaluate against a previously installed dump. */
type CachedEvaluateRequest = EvaluationFields & { kind: "evaluate"; installId: string };

type Request = InlineRequest | InstallRequest | CachedEvaluateRequest;

type WorkerScope = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, options?: { transfer?: Transferable[] }) => void;
};
const scope = self as unknown as WorkerScope;

// Latest installed dump; deliberately a single slot so stale imports never pin
// multi-megabyte payloads in worker memory.
let installed: { installId: string; dump: Dump } | null = null;

scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.kind === "install") {
    installed = { installId: request.installId, dump: request.dump };
    scope.postMessage({ ok: true as const, installed: request.installId });
    return;
  }
  if (request.kind === "evaluate") {
    if (!installed || installed.installId !== request.installId) {
      scope.postMessage({
        id: request.id,
        ok: false as const,
        unknownInstall: true,
        error: `no installed dump for ${request.installId}`,
      });
      return;
    }
    // Evaluation reads the dump without mutating it, except when a curves
    // payload replaces object curve data in-place. Clone only for that case so
    // the cached dump stays pristine across evaluations.
    const dump = request.curves || request.collectionSpheres || request.collectionCylinders
      ? structuredClone(installed.dump)
      : installed.dump;
    await evaluate(dump, request);
    return;
  }
  await evaluate(request.dump, request);
};

const ICO_VERTICES: [number, number, number][] = (() => {
  const phi = (1 + Math.sqrt(5)) / 2;
  const raw: [number, number, number][] = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ];
  return raw.map(([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  });
})();

const ICO_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function transformPoint(matrix: number[][] | undefined, point: [number, number, number]): [number, number, number] {
  if (!matrix?.length) return [...point];
  const [x, y, z] = point;
  return [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3],
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3],
    matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3],
  ];
}

function matrixScale(matrix: number[][] | undefined): number {
  if (!matrix?.length) return 1;
  return [0, 1, 2].reduce<number>((sum, column) => sum + Math.hypot(
    matrix[0][column], matrix[1][column], matrix[2][column],
  ), 0) / 3;
}

function transformDirection(matrix: number[][] | undefined, direction: [number, number, number]): [number, number, number] {
  const [x, y, z] = direction;
  const transformed: [number, number, number] = matrix?.length ? [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
    matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z,
  ] : [x, y, z];
  const length = Math.hypot(...transformed) || 1;
  return transformed.map((value) => value / length) as [number, number, number];
}

function cross(
  [ax, ay, az]: [number, number, number],
  [bx, by, bz]: [number, number, number],
): [number, number, number] {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function normalized(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length) as [number, number, number];
}

function cylinderMesh(
  direction: [number, number, number],
  radius: number,
  length: number,
  segments = 24,
): { verts: [number, number, number][]; faces: number[][]; edges: [number, number][]; face_materials: number[] } {
  const axis = normalized(direction);
  const helper: [number, number, number] = Math.abs(axis[2]) < .9 ? [0, 0, 1] : [0, 1, 0];
  const tangent = normalized(cross(axis, helper));
  const bitangent = normalized(cross(axis, tangent));
  const verts: [number, number, number][] = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < segments; index++) {
      const angle = index / segments * Math.PI * 2;
      const radialX = Math.cos(angle) * radius;
      const radialY = Math.sin(angle) * radius;
      verts.push([
        axis[0] * side * length / 2 + tangent[0] * radialX + bitangent[0] * radialY,
        axis[1] * side * length / 2 + tangent[1] * radialX + bitangent[1] * radialY,
        axis[2] * side * length / 2 + tangent[2] * radialX + bitangent[2] * radialY,
      ]);
    }
  }
  const bottomCenter = verts.length; verts.push(axis.map((value) => -value * length / 2) as [number, number, number]);
  const topCenter = verts.length; verts.push(axis.map((value) => value * length / 2) as [number, number, number]);
  const faces: number[][] = [];
  for (let index = 0; index < segments; index++) {
    const next = (index + 1) % segments;
    faces.push([index, next, segments + next, segments + index]);
    faces.push([bottomCenter, next, index]);
    faces.push([topCenter, segments + index, segments + next]);
  }
  return { verts, faces, edges: [], face_materials: faces.map(() => 0) };
}

function installCollectionSpheres(dump: Dump, seed: NonNullable<EvaluationFields["collectionSpheres"]>): void {
  const collection = dump.collections?.find((candidate) => candidate.name === seed.collection);
  if (!collection) throw new Error(`collection seed target not found: ${seed.collection}`);
  const relativeObject = seed.relativeToObject
    ? dump.objects?.find((candidate) => candidate.name === seed.relativeToObject)
    : undefined;
  const relativeMatrix = relativeObject?.matrix_world;
  const relativeScale = matrixScale(relativeMatrix);
  const names: string[] = [];
  const generated = seed.spheres.map((sphere, index) => {
    const name = `__GNVM_COLLECTION_SPHERE_${index}`;
    names.push(name);
    const location = transformPoint(relativeMatrix, sphere.position);
    const radius = Math.max(0.001, sphere.radius * relativeScale);
    const mesh = {
      verts: ICO_VERTICES.map(([x, y, z]) => [x * radius, y * radius, z * radius] as [number, number, number]),
      faces: ICO_FACES.map((face) => [...face]),
      edges: [] as [number, number][],
      face_materials: ICO_FACES.map(() => 0),
    };
    return {
      name,
      type: "MESH" as const,
      visible: true,
      location,
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      matrix_world: [
        [1, 0, 0, location[0]],
        [0, 1, 0, location[1]],
        [0, 0, 1, location[2]],
        [0, 0, 0, 1],
      ],
      materials: [],
      modifiers: [],
      mesh,
      evaluated_mesh: mesh,
    };
  });
  collection.objects = names;
  dump.objects = [
    ...(dump.objects ?? []).filter((object) => !object.name.startsWith("__GNVM_COLLECTION_SPHERE_")),
    ...generated,
  ];
}

function installCollectionCylinders(
  dump: Dump,
  seed: NonNullable<EvaluationFields["collectionCylinders"]>,
  append = false,
): void {
  const collection = dump.collections?.find((candidate) => candidate.name === seed.collection);
  if (!collection) throw new Error(`collection seed target not found: ${seed.collection}`);
  const relativeObject = seed.relativeToObject
    ? dump.objects?.find((candidate) => candidate.name === seed.relativeToObject)
    : undefined;
  const relativeMatrix = relativeObject?.matrix_world;
  const relativeScale = matrixScale(relativeMatrix);
  const names: string[] = [];
  const generated = seed.cylinders.map((cylinder, index) => {
    const name = `__GNVM_COLLECTION_CYLINDER_${index}`;
    names.push(name);
    const location = transformPoint(relativeMatrix, cylinder.position);
    const mesh = cylinderMesh(
      transformDirection(relativeMatrix, cylinder.direction),
      Math.max(.001, cylinder.radius * relativeScale),
      Math.max(.001, cylinder.length * relativeScale),
    );
    return {
      name,
      type: "MESH" as const,
      visible: true,
      location,
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      matrix_world: [
        [1, 0, 0, location[0]],
        [0, 1, 0, location[1]],
        [0, 0, 1, location[2]],
        [0, 0, 0, 1],
      ],
      materials: [],
      modifiers: [],
      mesh,
      evaluated_mesh: mesh,
    };
  });
  collection.objects = append ? [...(collection.objects ?? []), ...names] : names;
  dump.objects = [
    ...(dump.objects ?? []).filter((object) => !object.name.startsWith("__GNVM_COLLECTION_CYLINDER_")),
    ...generated,
  ];
}

async function evaluate(dump: Dump, request: EvaluationFields): Promise<void> {
  const {
    id,
    object,
    group,
    modifierIndex,
    targetKind,
    overrides,
    seed,
    geometryInput,
    output,
    curves,
    collectionSpheres,
    collectionCylinders,
    probe,
    frame,
    volumeSampleBudget,
  } = request;
  try {
    setDenseSdfSampleBudget(volumeSampleBudget ?? null);
    if (collectionSpheres) installCollectionSpheres(dump, collectionSpheres);
    if (collectionCylinders) installCollectionCylinders(
      dump,
      collectionCylinders,
      Boolean(collectionSpheres && collectionSpheres.collection === collectionCylinders.collection),
    );
    if (curves) {
      if (!object) throw new Error("curve overrides require an object target");
      const target = dump.objects?.find((candidate) => candidate.name === object);
      if (!target) throw new Error(`curve target object not found: ${object}`);
      target.curves = curves;
    }
    GEOMETRY_PROBE.group = probe?.group ?? null;
    GEOMETRY_PROBE.node = probe?.node ?? null;
    GEOMETRY_PROBE.socket = probe?.socket ?? null;
    GEOMETRY_PROBE.geometry = null;
    const result = await runGeometryTarget(
      dump,
      targetKind === "group"
        ? {
          kind: "group",
          group: group ?? "",
          overrides,
          seed,
          geometryInput,
          output,
          frame,
        }
        : {
          kind: "object",
          object,
          group,
          modifierIndex,
          overrides,
          seed,
          geometryInput,
          frame,
        },
    );
    const probeSoup = GEOMETRY_PROBE.geometry ? toTriSoup(GEOMETRY_PROBE.geometry) : undefined;
    const payload = {
      id,
      ok: true as const,
      soup: {
        positions: result.soup.positions,
        normals: result.soup.normals,
        indices: result.soup.indices,
        cornerNormals: result.soup.cornerNormals,
        triangleFaces: result.soup.triangleFaces,
        triangleCorners: result.soup.triangleCorners,
        attributes: result.soup.attributes,
        groups: result.soup.groups,
        stats: result.soup.stats,
        lines: result.soup.lines,
        points: result.soup.points,
      },
      coverage: result.coverage,
      details: result.details ?? [],
      probeSoup: probeSoup ? transferableSoup(probeSoup) : undefined,
    };
    const transfer: Transferable[] = [result.soup.positions.buffer, result.soup.normals.buffer, result.soup.indices.buffer];
    if (result.soup.cornerNormals) transfer.push(result.soup.cornerNormals.buffer);
    if (result.soup.triangleFaces) transfer.push(result.soup.triangleFaces.buffer);
    if (result.soup.triangleCorners) transfer.push(result.soup.triangleCorners.buffer);
    if (result.soup.lines) transfer.push(result.soup.lines.positions.buffer);
    if (result.soup.points)
      transfer.push(result.soup.points.positions.buffer, result.soup.points.radii.buffer);
    for (const attribute of Object.values(result.soup.attributes)) {
      transfer.push(attribute.data.buffer);
      if (attribute.domainData) transfer.push(attribute.domainData.buffer);
    }
    if (probeSoup) {
      transfer.push(probeSoup.positions.buffer, probeSoup.normals.buffer, probeSoup.indices.buffer);
      if (probeSoup.cornerNormals) transfer.push(probeSoup.cornerNormals.buffer);
      if (probeSoup.triangleFaces) transfer.push(probeSoup.triangleFaces.buffer);
      if (probeSoup.triangleCorners) transfer.push(probeSoup.triangleCorners.buffer);
      if (probeSoup.lines) transfer.push(probeSoup.lines.positions.buffer);
      if (probeSoup.points)
        transfer.push(probeSoup.points.positions.buffer, probeSoup.points.radii.buffer);
      for (const attribute of Object.values(probeSoup.attributes)) {
        transfer.push(attribute.data.buffer);
        if (attribute.domainData) transfer.push(attribute.domainData.buffer);
      }
    }
    scope.postMessage(payload, {
      transfer,
    });
  } catch (error) {
    scope.postMessage({
      id,
      ok: false as const,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  } finally {
    setDenseSdfSampleBudget(null);
    GEOMETRY_PROBE.group = null;
    GEOMETRY_PROBE.node = null;
    GEOMETRY_PROBE.socket = null;
    GEOMETRY_PROBE.geometry = null;
  }
}

function transferableSoup(soup: TriSoup): TriSoup {
  return {
    positions: soup.positions,
    normals: soup.normals,
    indices: soup.indices,
    cornerNormals: soup.cornerNormals,
    triangleFaces: soup.triangleFaces,
    triangleCorners: soup.triangleCorners,
    groups: soup.groups,
    stats: soup.stats,
    attributes: soup.attributes,
    lines: soup.lines,
    points: soup.points,
  };
}
