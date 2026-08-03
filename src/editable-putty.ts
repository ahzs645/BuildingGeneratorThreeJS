export type PuttyPoint = [number, number, number];

export type PuttyBlob = {
  id: number;
  position: PuttyPoint;
  radius: number;
};

export type PuttyPipe = {
  id: number;
  position: PuttyPoint;
  direction: PuttyPoint;
  radius: number;
  length: number;
  locked: boolean;
};

function normalized(point: PuttyPoint): PuttyPoint {
  const length = Math.hypot(...point) || 1;
  return point.map((value) => value / length) as PuttyPoint;
}

/**
 * Stable, renderer-independent source document for Bubble Putty authoring.
 * Generated metaball/GN meshes are disposable views of this small blob list.
 */
export class EditablePuttyDocument {
  readonly blobs: PuttyBlob[] = [];
  selectedId: number | null = null;
  private nextId = 1;

  add(position: PuttyPoint, radius = 1): PuttyBlob {
    const blob = { id: this.nextId++, position: [...position] as PuttyPoint, radius: Math.max(.05, radius) };
    this.blobs.push(blob);
    this.selectedId = blob.id;
    return blob;
  }

  selected(): PuttyBlob | undefined {
    return this.blobs.find((blob) => blob.id === this.selectedId);
  }

  select(id: number | null): boolean {
    if (id !== null && !this.blobs.some((blob) => blob.id === id)) return false;
    this.selectedId = id;
    return true;
  }

  moveSelected(position: PuttyPoint): boolean {
    const blob = this.selected();
    if (!blob) return false;
    blob.position = [...position] as PuttyPoint;
    return true;
  }

  resizeSelected(radius: number): boolean {
    const blob = this.selected();
    if (!blob) return false;
    blob.radius = Math.max(.05, radius);
    return true;
  }

  duplicateSelected(offset: PuttyPoint = [.65, .35, 0]): PuttyBlob | undefined {
    const blob = this.selected();
    if (!blob) return undefined;
    return this.add([
      blob.position[0] + offset[0],
      blob.position[1] + offset[1],
      blob.position[2] + offset[2],
    ], blob.radius);
  }

  deleteSelected(): boolean {
    const index = this.blobs.findIndex((blob) => blob.id === this.selectedId);
    if (index < 0) return false;
    this.blobs.splice(index, 1);
    this.selectedId = this.blobs.at(-1)?.id ?? null;
    return true;
  }

  clear(): void {
    this.blobs.length = 0;
    this.selectedId = null;
  }

  reset(): void {
    this.clear();
    this.add([-1.15, -.35, 0], 1.05);
    this.add([0, .35, .15], 1.2);
    this.add([1.15, -.2, -.1], .9);
    this.selectedId = this.blobs[1].id;
  }

  resetForPipeJoint(): void {
    this.clear();
    this.add([-.72, 0, .58], .32);
    this.add([0, .62, 0], .36);
    this.add([.72, 0, -.58], .3);
    this.selectedId = this.blobs[1].id;
  }

  toSeed(subdivisions = 2): {
    kind: "ico-spheres";
    subdivisions: number;
    spheres: Array<{ position: PuttyPoint; radius: number }>;
  } {
    return {
      kind: "ico-spheres",
      subdivisions,
      spheres: this.blobs.map(({ position, radius }) => ({ position: [...position] as PuttyPoint, radius })),
    };
  }
}

/**
 * Three-dimensional fixture document for collection-driven putty graphs.
 * Exactly one pipe can be the immovable anchor surface; the remaining pipes
 * stay editable relative to it.
 */
export class EditablePipeFixture {
  readonly pipes: PuttyPipe[] = [];
  selectedId: number | null = null;
  private nextId = 1;

  add(
    position: PuttyPoint,
    direction: PuttyPoint,
    radius = .5,
    length = 6,
    locked = false,
  ): PuttyPipe {
    const pipe = {
      id: this.nextId++,
      position: [...position] as PuttyPoint,
      direction: normalized(direction),
      radius: Math.max(.05, radius),
      length: Math.max(.1, length),
      locked,
    };
    this.pipes.push(pipe);
    this.selectedId = pipe.id;
    return pipe;
  }

  selected(): PuttyPipe | undefined {
    return this.pipes.find((pipe) => pipe.id === this.selectedId);
  }

  select(id: number | null): boolean {
    if (id !== null && !this.pipes.some((pipe) => pipe.id === id)) return false;
    this.selectedId = id;
    return true;
  }

  moveSelected(position: PuttyPoint): boolean {
    const pipe = this.selected();
    if (!pipe || pipe.locked) return false;
    pipe.position = [...position] as PuttyPoint;
    return true;
  }

  resizeSelected(radius: number): boolean {
    const pipe = this.selected();
    if (!pipe) return false;
    pipe.radius = Math.max(.05, radius);
    return true;
  }

  lockSelected(): boolean {
    const selected = this.selected();
    if (!selected) return false;
    for (const pipe of this.pipes) pipe.locked = pipe.id === selected.id;
    return true;
  }

  clear(): void {
    this.pipes.length = 0;
    this.selectedId = null;
    this.nextId = 1;
  }

  resetThreePipes(): void {
    this.clear();
    this.add([0, 0, 0], [1, 0, 0], .52, 7.2, true);
    this.add([0, .05, 0], [0, 1, 0], .46, 6.4);
    this.add([.15, -.1, .05], [.46, .24, .86], .42, 6);
    this.selectedId = this.pipes[1].id;
  }

  toCylinders(): Array<{
    position: PuttyPoint;
    direction: PuttyPoint;
    radius: number;
    length: number;
  }> {
    return this.pipes.map(({ position, direction, radius, length }) => ({
      position: [...position] as PuttyPoint,
      direction: [...direction] as PuttyPoint,
      radius,
      length,
    }));
  }
}
