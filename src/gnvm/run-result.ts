import type { Geometry, TriSoup } from "./geometry";

export interface RunCoverage {
  handled: number;
  missingTypes: { type: string; count: number }[];
}

export interface RunResult {
  geometry: Geometry;
  soup: TriSoup;
  coverage: RunCoverage;
}
