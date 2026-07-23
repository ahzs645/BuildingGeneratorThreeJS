import { GEOMETRY_PROBE, runGenerator, toTriSoup, type Dump, type TriSoup } from "./gnvm/index";

type Request = {
  id: number;
  dump: Dump;
  object: string;
  overrides: Record<string, number | boolean>;
  curves?: { points: number[][]; cyclic: boolean; tilts?: number[] }[];
  probe?: { group: string; node: string; socket?: string };
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, options?: { transfer?: Transferable[] }) => void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = async (event: MessageEvent<Request>) => {
  const { id, dump, object, overrides, curves, probe } = event.data;
  try {
    if (curves) {
      const target = dump.objects?.find((candidate) => candidate.name === object);
      if (!target) throw new Error(`curve target object not found: ${object}`);
      target.curves = curves;
    }
    GEOMETRY_PROBE.group = probe?.group ?? null;
    GEOMETRY_PROBE.node = probe?.node ?? null;
    GEOMETRY_PROBE.socket = probe?.socket ?? null;
    GEOMETRY_PROBE.geometry = null;
    const result = await runGenerator(dump, { object, overrides });
    const probeSoup = GEOMETRY_PROBE.geometry ? toTriSoup(GEOMETRY_PROBE.geometry) : undefined;
    const payload = {
      id,
      ok: true as const,
      soup: {
        positions: result.soup.positions,
        normals: result.soup.normals,
        indices: result.soup.indices,
        triangleFaces: result.soup.triangleFaces,
        triangleCorners: result.soup.triangleCorners,
        attributes: result.soup.attributes,
        groups: result.soup.groups,
        stats: result.soup.stats,
        lines: result.soup.lines,
      },
      coverage: result.coverage,
      probeSoup: probeSoup ? transferableSoup(probeSoup) : undefined,
    };
    const transfer: Transferable[] = [result.soup.positions.buffer, result.soup.normals.buffer, result.soup.indices.buffer];
    if (result.soup.triangleFaces) transfer.push(result.soup.triangleFaces.buffer);
    if (result.soup.triangleCorners) transfer.push(result.soup.triangleCorners.buffer);
    if (result.soup.lines) transfer.push(result.soup.lines.positions.buffer);
    for (const attribute of Object.values(result.soup.attributes)) {
      transfer.push(attribute.data.buffer);
      if (attribute.domainData) transfer.push(attribute.domainData.buffer);
    }
    if (probeSoup) {
      transfer.push(probeSoup.positions.buffer, probeSoup.normals.buffer, probeSoup.indices.buffer);
      if (probeSoup.triangleFaces) transfer.push(probeSoup.triangleFaces.buffer);
      if (probeSoup.triangleCorners) transfer.push(probeSoup.triangleCorners.buffer);
      if (probeSoup.lines) transfer.push(probeSoup.lines.positions.buffer);
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
    GEOMETRY_PROBE.group = null;
    GEOMETRY_PROBE.node = null;
    GEOMETRY_PROBE.socket = null;
    GEOMETRY_PROBE.geometry = null;
  }
};

function transferableSoup(soup: TriSoup): TriSoup {
  return {
    positions: soup.positions,
    normals: soup.normals,
    indices: soup.indices,
    triangleFaces: soup.triangleFaces,
    triangleCorners: soup.triangleCorners,
    groups: soup.groups,
    stats: soup.stats,
    attributes: soup.attributes,
    lines: soup.lines,
  };
}
