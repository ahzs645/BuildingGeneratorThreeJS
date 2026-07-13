import { runGenerator, type Dump } from "./gnvm/index";

type Request = {
  id: number;
  dump: Dump;
  object: string;
  overrides: Record<string, number | boolean>;
  curves?: { points: number[][]; cyclic: boolean; tilts?: number[] }[];
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, options?: { transfer?: Transferable[] }) => void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = async (event: MessageEvent<Request>) => {
  const { id, dump, object, overrides, curves } = event.data;
  try {
    if (curves) {
      const target = dump.objects?.find((candidate) => candidate.name === object);
      if (!target) throw new Error(`curve target object not found: ${object}`);
      target.curves = curves;
    }
    const result = await runGenerator(dump, { object, overrides });
    const payload = {
      id,
      ok: true as const,
      soup: {
        positions: result.soup.positions,
        normals: result.soup.normals,
        indices: result.soup.indices,
        groups: result.soup.groups,
        stats: result.soup.stats,
      },
      coverage: result.coverage,
    };
    scope.postMessage(payload, {
      transfer: [result.soup.positions.buffer, result.soup.normals.buffer, result.soup.indices.buffer],
    });
  } catch (error) {
    scope.postMessage({
      id,
      ok: false as const,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
};
