import * as THREE from 'three/webgpu';
import type {
  DrawingAreaLineData,
  DrawingAreaProjectionResult,
} from './drawing-area-controller';
import type { Vec3 } from './contracts';

export interface DrawingAreaOverlayOptions {
  readonly parent?: THREE.Object3D;
  readonly renderOrder?: number;
  readonly sourceColor?: THREE.ColorRepresentation;
  readonly contactColor?: THREE.ColorRepresentation;
  readonly patchLineColor?: THREE.ColorRepresentation;
  readonly rayColor?: THREE.ColorRepresentation;
}

/**
 * WebGPU-safe scene helpers for DrawingAreaController projection output.
 *
 * The helper deliberately uses only core LineSegments/LineBasicMaterial and
 * Mesh/MeshBasicMaterial. It never relies on the WebGL-only LineMaterial.
 */
export class DrawingAreaOverlay {
  readonly group = new THREE.Group();

  private readonly sourceGrid: THREE.LineSegments;
  private readonly projectionRay: THREE.LineSegments;
  private readonly patchFill: THREE.Mesh;
  private readonly patchLines: THREE.LineSegments;
  private readonly sourceMaterial: THREE.LineBasicMaterial;
  private readonly rayMaterial: THREE.LineBasicMaterial;
  private readonly patchMaterial: THREE.MeshBasicMaterial;
  private readonly patchLineMaterial: THREE.LineBasicMaterial;
  private disposed = false;

  constructor(options: DrawingAreaOverlayOptions = {}) {
    const renderOrder = options.renderOrder ?? 20;
    this.group.name = 'Surface Studio drawing area overlay';

    this.sourceMaterial = new THREE.LineBasicMaterial({
      color: options.sourceColor ?? 0xdce5e3,
      transparent: true,
      opacity: 0.74,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.rayMaterial = new THREE.LineBasicMaterial({
      color: options.rayColor ?? 0x65ff74,
      transparent: true,
      opacity: 0.94,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.patchMaterial = new THREE.MeshBasicMaterial({
      color: options.contactColor ?? 0xffff32,
      transparent: true,
      opacity: 0.58,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.patchLineMaterial = new THREE.LineBasicMaterial({
      color: options.patchLineColor ?? 0xffffb0,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.sourceGrid = new THREE.LineSegments(new THREE.BufferGeometry(), this.sourceMaterial);
    this.sourceGrid.name = 'Drawing area source grid';
    this.sourceGrid.renderOrder = renderOrder;
    this.sourceGrid.frustumCulled = false;

    this.projectionRay = new THREE.LineSegments(new THREE.BufferGeometry(), this.rayMaterial);
    this.projectionRay.name = 'Drawing area projection ray';
    this.projectionRay.renderOrder = renderOrder + 1;
    this.projectionRay.frustumCulled = false;

    this.patchFill = new THREE.Mesh(new THREE.BufferGeometry(), this.patchMaterial);
    this.patchFill.name = 'Drawing area conformed patch';
    this.patchFill.renderOrder = renderOrder + 2;
    this.patchFill.frustumCulled = false;

    this.patchLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.patchLineMaterial);
    this.patchLines.name = 'Drawing area conformed grid';
    this.patchLines.renderOrder = renderOrder + 3;
    this.patchLines.frustumCulled = false;

    this.group.add(this.sourceGrid, this.projectionRay, this.patchFill, this.patchLines);
    options.parent?.add(this.group);
    this.hideHelpers();
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  update(result: DrawingAreaProjectionResult): void {
    if (this.disposed) return;

    const source = result.source;
    replaceGeometry(this.sourceGrid, source ? lineGeometry(source.lines) : new THREE.BufferGeometry());
    replaceGeometry(
      this.projectionRay,
      source
        ? segmentGeometry(source.projectionRay[0], source.projectionRay[1])
        : new THREE.BufferGeometry(),
    );
    this.sourceGrid.visible = Boolean(source?.lines.length);
    this.projectionRay.visible = Boolean(source);

    const patch = result.patch;
    replaceGeometry(this.patchFill, patch ? patchGeometry(patch.positions, patch.indices) : new THREE.BufferGeometry());
    replaceGeometry(this.patchLines, patch ? lineGeometry(patch.lines) : new THREE.BufferGeometry());
    this.patchFill.visible = Boolean(patch?.indices.length);
    this.patchLines.visible = Boolean(patch?.lines.length);
    this.patchMaterial.opacity = result.committed ? 0.68 : result.contact ? 0.58 : 0.5;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const object of [this.sourceGrid, this.projectionRay, this.patchFill, this.patchLines]) {
      object.geometry.dispose();
    }
    this.sourceMaterial.dispose();
    this.rayMaterial.dispose();
    this.patchMaterial.dispose();
    this.patchLineMaterial.dispose();
    this.group.clear();
  }

  private hideHelpers(): void {
    this.sourceGrid.visible = false;
    this.projectionRay.visible = false;
    this.patchFill.visible = false;
    this.patchLines.visible = false;
  }
}

function replaceGeometry(
  object: THREE.Mesh | THREE.LineSegments,
  geometry: THREE.BufferGeometry,
): void {
  const previous = object.geometry;
  object.geometry = geometry;
  previous.dispose();
}

function lineGeometry(lines: readonly DrawingAreaLineData[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const { points } of lines) {
    for (let index = 1; index < points.length; index++) {
      positions.push(...points[index - 1], ...points[index]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function segmentGeometry(start: Vec3, end: Vec3): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...start, ...end], 3));
  return geometry;
}

function patchGeometry(
  positions: readonly Vec3[],
  indices: readonly number[],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions.flatMap((point) => [...point]), 3),
  );
  geometry.setIndex([...indices]);
  return geometry;
}
