import { runGenerator, type Dump } from "./gnvm/index";

type Request = {
  id: number;
  dump: Dump;
  object: string;
  overrides: Record<string, number | boolean>;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, options?: { transfer?: Transferable[] }) => void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = async (event: MessageEvent<Request>) => {
  const { id, dump, object, overrides } = event.data;
  try {
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
