export const MATERIAL_BACKENDS = [
  "materialx",
  "baked-pbr",
  "legacy-authored",
  "normalized",
] as const;

export type MaterialBackend = typeof MATERIAL_BACKENDS[number];

export type MaterialBackendAvailability = Readonly<Partial<Record<MaterialBackend, boolean>>>;

export type MaterialBackendResolution = {
  requested: MaterialBackend;
  resolved: MaterialBackend;
  attempted: readonly MaterialBackend[];
  fallbackReason: string | null;
};

const FALLBACKS: Readonly<Record<MaterialBackend, readonly MaterialBackend[]>> = {
  materialx: ["materialx", "baked-pbr", "legacy-authored", "normalized"],
  "baked-pbr": ["baked-pbr", "legacy-authored", "normalized"],
  "legacy-authored": ["legacy-authored", "normalized"],
  normalized: ["normalized"],
};

/**
 * Resolve a requested shader backend without changing the existing production
 * material dispatch. Callers opt into this contract one material at a time.
 */
export function resolveMaterialBackend(
  requested: MaterialBackend,
  availability: MaterialBackendAvailability,
): MaterialBackendResolution {
  const attempted: MaterialBackend[] = [];
  for (const backend of FALLBACKS[requested]) {
    attempted.push(backend);
    if (availability[backend] === true) {
      return {
        requested,
        resolved: backend,
        attempted,
        fallbackReason: backend === requested
          ? null
          : `${requested} unavailable; selected ${backend}`,
      };
    }
  }

  // Normalized is the contract's terminal safety material, even when a caller
  // omitted its availability flag. This keeps resolution total and predictable.
  if (!attempted.includes("normalized")) attempted.push("normalized");
  return {
    requested,
    resolved: "normalized",
    attempted,
    fallbackReason: `${requested} and all declared fallbacks unavailable; selected normalized`,
  };
}
