import * as THREE from 'three/webgpu';
import { SurfaceProjector } from './surface-projector';

/**
 * Screen-facing corner brackets around the currently selected projection
 * target. The geometry is rebuilt from target bounds in NDC, then unprojected
 * so it remains part of the WebGPU scene without relying on WebGL Line2.
 */
export class SurfaceSelectionGuides {
  readonly lines: THREE.LineSegments;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: 0xffff5b,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly worldBounds = new THREE.Box3();
  private readonly viewBounds = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly arm = new THREE.Vector3();
  private disposed = false;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly projector: SurfaceProjector,
    parent?: THREE.Object3D,
  ) {
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = 'Chrome Crayon initial selection brackets';
    this.lines.renderOrder = 1000;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    parent?.add(this.lines);
  }

  setVisible(visible: boolean): void {
    this.lines.visible = visible && this.geometry.getAttribute('position') !== undefined;
  }

  update(enabled: boolean): void {
    if (this.disposed || !enabled) {
      this.lines.visible = false;
      return;
    }

    this.worldBounds.makeEmpty();
    for (const { mesh } of this.projector.selectedTargets()) {
      this.worldBounds.expandByObject(mesh, true);
    }
    if (this.worldBounds.isEmpty()) {
      this.lines.visible = false;
      return;
    }

    this.camera.updateMatrixWorld(true);
    this.viewBounds.makeEmpty();
    for (const xSide of [-1, 1]) for (const ySide of [-1, 1]) for (const zSide of [-1, 1]) {
      this.point.set(
        xSide < 0 ? this.worldBounds.min.x : this.worldBounds.max.x,
        ySide < 0 ? this.worldBounds.min.y : this.worldBounds.max.y,
        zSide < 0 ? this.worldBounds.min.z : this.worldBounds.max.z,
      ).project(this.camera);
      this.viewBounds.expandByPoint(this.point);
    }

    const centerX = (this.viewBounds.min.x + this.viewBounds.max.x) * 0.5;
    const centerY = (this.viewBounds.min.y + this.viewBounds.max.y) * 0.5;
    const width = this.viewBounds.max.x - this.viewBounds.min.x;
    const height = this.viewBounds.max.y - this.viewBounds.min.y;
    const halfX = Math.min(Math.max(0.16, width * 0.48), Math.max(0.16, 0.92 - Math.abs(centerX)));
    const halfY = Math.min(Math.max(0.16, height * 0.48), Math.max(0.16, 0.92 - Math.abs(centerY)));
    const nearZ = Math.max(-0.98, this.viewBounds.min.z - 0.002);
    const farZ = Math.min(0.998, this.viewBounds.max.z + 0.002);
    const rearScale = 0.74;
    const armFraction = 0.17;
    const positions: number[] = [];
    const write = (from: THREE.Vector3, to: THREE.Vector3): void => {
      positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
    };

    for (const xSide of [-1, 1]) for (const ySide of [-1, 1]) for (const zSide of [-1, 1]) {
      const planeScale = zSide < 0 ? 1 : rearScale;
      const otherScale = zSide < 0 ? rearScale : 1;
      this.corner.set(
        centerX + xSide * halfX * planeScale,
        centerY + ySide * halfY * planeScale,
        zSide < 0 ? nearZ : farZ,
      ).unproject(this.camera);

      this.arm.copy(this.corner);
      const xArm = new THREE.Vector3(
        centerX + xSide * halfX * planeScale * (1 - armFraction),
        centerY + ySide * halfY * planeScale,
        zSide < 0 ? nearZ : farZ,
      ).unproject(this.camera);
      write(this.corner, xArm);

      const yArm = new THREE.Vector3(
        centerX + xSide * halfX * planeScale,
        centerY + ySide * halfY * planeScale * (1 - armFraction),
        zSide < 0 ? nearZ : farZ,
      ).unproject(this.camera);
      write(this.corner, yArm);

      const depthTarget = new THREE.Vector3(
        centerX + xSide * halfX * otherScale,
        centerY + ySide * halfY * otherScale,
        zSide < 0 ? farZ : nearZ,
      ).unproject(this.camera);
      this.arm.copy(this.corner).lerp(depthTarget, armFraction);
      write(this.corner, this.arm);
    }

    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.computeBoundingSphere();
    this.lines.visible = positions.length > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
