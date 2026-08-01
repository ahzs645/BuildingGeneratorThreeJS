export type PuttyPoint = [number, number, number];

export type PuttyBlob = {
  id: number;
  position: PuttyPoint;
  radius: number;
};

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
