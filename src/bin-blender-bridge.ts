export type BinBridgeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BinBlenderBridgeStatus = {
  available: boolean;
  endpoint: string | null;
  detail?: string;
  dependencyComplete?: boolean;
  missingFonts?: string[];
  missingImages?: string[];
};

export function binBlenderBridgeEndpoint(hostname: string): string | null {
  return hostname === "localhost" || hostname === "127.0.0.1"
    ? `http://${hostname}:7801`
    : null;
}

export async function probeBinBlenderBridge(
  fetcher: BinBridgeFetch,
  hostname: string,
): Promise<BinBlenderBridgeStatus> {
  const endpoint = binBlenderBridgeEndpoint(hostname);
  if (!endpoint) return { available: false, endpoint: null, detail: "The live Blender bridge is local-only" };
  try {
    const response = await fetcher(`${endpoint}/status`);
    if (!response.ok) return { available: false, endpoint, detail: `Status request failed (${response.status})` };
    const status = await response.json() as {
      ready?: boolean;
      dependencies?: {
        completeForGeometry?: boolean;
        missingFonts?: Array<{ name?: string; path?: string }>;
        missingImages?: Array<{ name?: string; path?: string }>;
      };
    };
    return {
      available: status.ready === true,
      endpoint,
      detail: status.ready === true ? "Blender bake service is ready" : "Bridge is running but Blender is not ready",
      dependencyComplete: status.dependencies?.completeForGeometry !== false,
      missingFonts: (status.dependencies?.missingFonts ?? []).map((item) => item.name ?? item.path ?? "unknown font"),
      missingImages: (status.dependencies?.missingImages ?? []).map((item) => item.name ?? item.path ?? "unknown image"),
    };
  } catch (error) {
    return {
      available: false,
      endpoint,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function requestBinBlenderBake(
  fetcher: BinBridgeFetch,
  hostname: string,
  parameters: Record<string, number | boolean>,
): Promise<ArrayBuffer> {
  const endpoint = binBlenderBridgeEndpoint(hostname);
  if (!endpoint) throw new Error("The live Blender bridge is only available on localhost");
  const response = await fetcher(`${endpoint}/bake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parameters),
  });
  if (!response.ok) throw new Error(`Blender bake failed (${response.status}): ${await response.text()}`);
  const payload = await response.arrayBuffer();
  if (payload.byteLength === 0) throw new Error("Blender bake returned an empty GLB payload");
  return payload;
}
