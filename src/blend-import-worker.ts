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
    const dump = request.curves ? structuredClone(installed.dump) : installed.dump;
    await evaluate(dump, request);
    return;
  }
  await evaluate(request.dump, request);
};

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
    probe,
    frame,
    volumeSampleBudget,
  } = request;
  try {
    setDenseSdfSampleBudget(volumeSampleBudget ?? null);
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
