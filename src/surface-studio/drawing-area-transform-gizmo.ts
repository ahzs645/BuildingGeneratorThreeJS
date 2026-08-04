import * as THREE from 'three/webgpu';
import type { DrawingAreaController } from './drawing-area-controller';
import type { DrawingAreaState } from './contracts';

export type DrawingAreaGizmoHandle =
  | 'axis-x'
  | 'axis-y'
  | 'axis-z'
  | 'plane-xy'
  | 'plane-xz'
  | 'plane-yz'
  | 'screen';

export type DrawingAreaGizmoSpace = 'world' | 'local';

export interface DrawingAreaGizmoHit {
  readonly handle: DrawingAreaGizmoHandle;
  readonly point: THREE.Vector3;
  readonly distance: number;
}

export interface DrawingAreaTransformGizmoOptions {
  readonly controller: DrawingAreaController;
  readonly parent?: THREE.Object3D;
  /** World axes by default. Local maps X/Y/Z to the area's U/V/normal frame. */
  readonly space?: DrawingAreaGizmoSpace;
  /** Approximate on-screen length of each axis. */
  readonly sizePixels?: number;
  /** Fixed world size; when supplied it takes precedence over sizePixels. */
  readonly worldSize?: number;
  readonly renderOrder?: number;
  readonly xColor?: THREE.ColorRepresentation;
  readonly yColor?: THREE.ColorRepresentation;
  readonly zColor?: THREE.ColorRepresentation;
  readonly onDragStateChange?: (
    dragging: boolean,
    handle: DrawingAreaGizmoHandle | null,
  ) => void;
  /** Override translation application (for example, map local Z to projection depth). */
  readonly onTranslate?: (
    increment: THREE.Vector3,
    handle: DrawingAreaGizmoHandle,
  ) => void;
}

interface DragSession {
  readonly handle: DrawingAreaGizmoHandle;
  readonly plane: THREE.Plane;
  readonly startPoint: THREE.Vector3;
  readonly axis: THREE.Vector3 | null;
  readonly planeNormal: THREE.Vector3;
  readonly applied: THREE.Vector3;
}

const LOCAL_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Y = new THREE.Vector3(0, 1, 0);
const LOCAL_Z = new THREE.Vector3(0, 0, 1);
const EPSILON = 1e-10;

/**
 * Renderer-safe Blender-style translation gizmo for a DrawingAreaController.
 *
 * It uses only core MeshBasicMaterial, LineBasicMaterial, Mesh and
 * LineSegments objects, so it works with the shared WebGPU renderer. The
 * class deliberately does not attach DOM listeners: SurfaceInputController
 * remains the single pointer owner and can call the pointer or ray APIs below.
 */
export class DrawingAreaTransformGizmo {
  readonly group = new THREE.Group();

  private readonly controller: DrawingAreaController;
  private readonly sizePixels: number;
  private readonly worldSize: number | null;
  private readonly renderOrder: number;
  private readonly onDragStateChange?: DrawingAreaTransformGizmoOptions['onDragStateChange'];
  private readonly onTranslate?: DrawingAreaTransformGizmoOptions['onTranslate'];
  private readonly pickables: THREE.Object3D[] = [];
  private readonly handles = new Map<THREE.Object3D, DrawingAreaGizmoHandle>();
  private readonly baseColors = new Map<THREE.Material, THREE.Color>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly worldOrigin = new THREE.Vector3();
  private visible = true;
  private enabled = true;
  private disposed = false;
  private scaleWorld = 1;
  private hovered: DrawingAreaGizmoHandle | null = null;
  private session: DragSession | null = null;
  private space: DrawingAreaGizmoSpace;
  private translationSnap: number | null = null;

  constructor(options: DrawingAreaTransformGizmoOptions) {
    this.controller = options.controller;
    this.space = options.space ?? 'world';
    this.sizePixels = Math.max(24, options.sizePixels ?? 118);
    this.worldSize = options.worldSize === undefined
      ? null
      : Math.max(1e-5, options.worldSize);
    this.renderOrder = options.renderOrder ?? 70;
    this.onDragStateChange = options.onDragStateChange;
    this.onTranslate = options.onTranslate;

    this.group.name = 'Drawing area transform gizmo';
    this.group.frustumCulled = false;
    this.buildAxis('axis-x', LOCAL_X, options.xColor ?? 0xff334a);
    this.buildAxis('axis-y', LOCAL_Y, options.yColor ?? 0x35e84f);
    this.buildAxis('axis-z', LOCAL_Z, options.zColor ?? 0x2f63ff);

    // Blender colors a plane handle by its normal: XY blue, XZ green, YZ red.
    this.buildPlane('plane-xy', LOCAL_X, LOCAL_Y, options.zColor ?? 0x2f63ff);
    this.buildPlane('plane-xz', LOCAL_X, LOCAL_Z, options.yColor ?? 0x35e84f);
    this.buildPlane('plane-yz', LOCAL_Y, LOCAL_Z, options.xColor ?? 0xff334a);
    this.buildScreenHandle(options.zColor ?? 0x365eff);

    options.parent?.add(this.group);
    this.group.visible = false;
  }

  get dragging(): boolean {
    return this.session !== null;
  }

  get activeHandle(): DrawingAreaGizmoHandle | null {
    return this.session?.handle ?? null;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.cancelDrag();
    this.enabled = enabled;
    this.updateVisibility();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateVisibility();
  }

  setSpace(space: DrawingAreaGizmoSpace): void {
    this.space = space;
  }

  setTranslationSnap(step: number | null): void {
    this.translationSnap = step === null ? null : Math.max(1e-6, step);
  }

  /**
   * Positions the gizmo at the floating source grid and keeps it approximately
   * the same pixel size at any camera distance. Call once per rendered frame.
   */
  sync(camera: THREE.Camera, viewportHeight: number): void {
    if (this.disposed) return;
    const area = this.controller.area;
    if (!area) {
      this.group.visible = false;
      return;
    }

    const normal = vector(area.normal).normalize();
    this.worldOrigin.copy(vector(area.center)).addScaledVector(normal, area.projectionHeight);
    this.setWorldPose(area);
    this.scaleWorld = this.worldSize
      ?? pixelWorldSize(camera, this.worldOrigin, viewportHeight, this.sizePixels);
    this.setWorldScale(this.scaleWorld);
    this.group.updateMatrixWorld(true);
    this.updateVisibility();
  }

  hitTest(ndc: THREE.Vector2, camera: THREE.Camera): DrawingAreaGizmoHit | null {
    this.raycaster.setFromCamera(ndc, camera);
    return this.hitTestRay(this.raycaster.ray);
  }

  hitTestRay(ray: THREE.Ray): DrawingAreaGizmoHit | null {
    if (!this.enabled || !this.group.visible || this.disposed) return null;
    this.group.updateMatrixWorld(true);
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = Number.POSITIVE_INFINITY;
    this.raycaster.params.Line = { threshold: Math.max(0.005, this.scaleWorld * 0.075) };
    const intersections = this.raycaster.intersectObjects(this.pickables, false);
    for (const intersection of intersections) {
      const handle = this.handles.get(intersection.object);
      if (handle) {
        return {
          handle,
          point: intersection.point.clone(),
          distance: intersection.distance,
        };
      }
    }
    return null;
  }

  setHovered(handle: DrawingAreaGizmoHandle | null): void {
    if (handle === this.hovered) return;
    this.hovered = handle;
    for (const object of this.pickables) {
      const material = materialOf(object);
      if (!material) continue;
      const base = this.baseColors.get(material);
      if (!base) continue;
      material.color.copy(base);
      if (this.handles.get(object) === handle) material.color.lerp(new THREE.Color(0xffffff), 0.62);
    }
  }

  /** Starts a history-grouped drag from an already raycast handle. */
  beginDrag(hit: DrawingAreaGizmoHit, ray: THREE.Ray): boolean {
    if (!this.enabled || this.disposed || this.session || !this.controller.area) return false;
    const frame = this.worldFrame();
    const axis = handleAxis(hit.handle, frame);
    const planeNormal = dragPlaneNormal(hit.handle, frame, ray.direction, axis);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, this.worldOrigin);
    const startPoint = ray.intersectPlane(plane, new THREE.Vector3());
    if (!startPoint) return false;

    this.controller.beginTransformDrag(`Move drawing area (${hit.handle})`);
    this.session = {
      handle: hit.handle,
      plane,
      startPoint,
      axis,
      planeNormal,
      applied: new THREE.Vector3(),
    };
    this.setHovered(hit.handle);
    this.onDragStateChange?.(true, hit.handle);
    return true;
  }

  beginPointerDrag(ndc: THREE.Vector2, camera: THREE.Camera): DrawingAreaGizmoHit | null {
    this.raycaster.setFromCamera(ndc, camera);
    const hit = this.hitTestRay(this.raycaster.ray);
    return hit && this.beginDrag(hit, this.raycaster.ray) ? hit : null;
  }

  dragTo(ndc: THREE.Vector2, camera: THREE.Camera): boolean {
    this.raycaster.setFromCamera(ndc, camera);
    return this.dragToRay(this.raycaster.ray);
  }

  dragToRay(ray: THREE.Ray): boolean {
    const session = this.session;
    if (!session || this.disposed) return false;
    const point = ray.intersectPlane(session.plane, new THREE.Vector3());
    if (!point) return false;

    const raw = point.sub(session.startPoint);
    let desired = session.axis
      ? session.axis.clone().multiplyScalar(raw.dot(session.axis))
      : raw.addScaledVector(session.planeNormal, -raw.dot(session.planeNormal));
    if (this.translationSnap) {
      const step = this.translationSnap;
      if (session.axis) {
        desired = session.axis.clone().multiplyScalar(
          Math.round(desired.dot(session.axis) / step) * step,
        );
      } else {
        const frame = this.worldFrame();
        desired = frame.reduce(
          (result, axis) => result.addScaledVector(
            axis,
            Math.round(desired.dot(axis) / step) * step,
          ),
          new THREE.Vector3(),
        );
      }
    }
    const increment = desired.clone().sub(session.applied);
    if (increment.lengthSq() <= EPSILON) return true;
    if (this.onTranslate) this.onTranslate(increment, session.handle);
    else this.controller.translate(increment);
    session.applied.copy(desired);
    return true;
  }

  endDrag(): void {
    if (!this.session) return;
    this.controller.commitTransformDrag();
    this.finishDrag();
  }

  cancelDrag(): void {
    if (!this.session) return;
    this.controller.cancelTransformDrag();
    this.finishDrag();
  }

  /**
   * Convenience DOM adapters. They do not capture pointers or toggle orbit;
   * the unified input controller remains responsible for both.
   */
  pointerDown(event: PointerEvent, element: HTMLElement, camera: THREE.Camera): DrawingAreaGizmoHit | null {
    const ndc = pointerNdc(element, event);
    return ndc ? this.beginPointerDrag(ndc, camera) : null;
  }

  pointerMove(event: PointerEvent, element: HTMLElement, camera: THREE.Camera): boolean {
    const ndc = pointerNdc(element, event);
    if (!ndc) return false;
    if (this.dragging) return this.dragTo(ndc, camera);
    this.setHovered(this.hitTest(ndc, camera)?.handle ?? null);
    return false;
  }

  pointerUp(commit = true): void {
    if (commit) this.endDrag();
    else this.cancelDrag();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelDrag();
    this.disposed = true;
    this.group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        geometries.add(object.geometry);
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.clear();
    this.pickables.length = 0;
    this.handles.clear();
    this.baseColors.clear();
  }

  private buildAxis(
    handle: DrawingAreaGizmoHandle,
    direction: THREE.Vector3,
    color: THREE.ColorRepresentation,
  ): void {
    const lineMaterial = this.lineMaterial(color);
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      direction.clone().multiplyScalar(0.82),
    ]);
    const line = new THREE.LineSegments(lineGeometry, lineMaterial);
    line.name = `Drawing area gizmo ${handle} shaft`;
    this.register(line, handle);

    const coneMaterial = this.meshMaterial(color, 1);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 12), coneMaterial);
    cone.name = `Drawing area gizmo ${handle} arrow`;
    cone.position.copy(direction).multiplyScalar(0.91);
    cone.quaternion.setFromUnitVectors(LOCAL_Y, direction);
    this.register(cone, handle);
  }

  private buildPlane(
    handle: DrawingAreaGizmoHandle,
    a: THREE.Vector3,
    b: THREE.Vector3,
    color: THREE.ColorRepresentation,
  ): void {
    const geometry = planeHandleGeometry(a, b);
    const mesh = new THREE.Mesh(geometry, this.meshMaterial(color, 0.32));
    mesh.name = `Drawing area gizmo ${handle} handle`;
    this.register(mesh, handle);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      this.lineMaterial(color, 0.86),
    );
    edges.name = `Drawing area gizmo ${handle} outline`;
    this.register(edges, handle);
  }

  private buildScreenHandle(color: THREE.ColorRepresentation): void {
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.095, 0),
      this.meshMaterial(color, 0.9),
    );
    mesh.name = 'Drawing area gizmo screen handle';
    this.register(mesh, 'screen');
  }

  private register(object: THREE.Object3D, handle: DrawingAreaGizmoHandle): void {
    object.renderOrder = this.renderOrder;
    object.frustumCulled = false;
    this.group.add(object);
    this.pickables.push(object);
    this.handles.set(object, handle);
  }

  private lineMaterial(color: THREE.ColorRepresentation, opacity = 1): THREE.LineBasicMaterial {
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.baseColors.set(material, material.color.clone());
    return material;
  }

  private meshMaterial(color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.baseColors.set(material, material.color.clone());
    return material;
  }

  private setWorldPose(area: DrawingAreaState): void {
    this.group.position.copy(this.worldOrigin);
    const parent = this.group.parent;
    if (parent) parent.worldToLocal(this.group.position);

    const worldRotation = this.space === 'local'
      ? new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        vector(area.u).normalize(),
        vector(area.v).normalize(),
        vector(area.normal).normalize(),
      ))
      : new THREE.Quaternion();
    if (parent) {
      const parentRotation = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.group.quaternion.copy(parentRotation.multiply(worldRotation));
    } else {
      this.group.quaternion.copy(worldRotation);
    }
  }

  private setWorldScale(scale: number): void {
    const parentScale = this.group.parent?.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
    this.group.scale.set(
      scale / Math.max(EPSILON, Math.abs(parentScale.x)),
      scale / Math.max(EPSILON, Math.abs(parentScale.y)),
      scale / Math.max(EPSILON, Math.abs(parentScale.z)),
    );
  }

  private worldFrame(): readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
    const rotation = this.group.getWorldQuaternion(new THREE.Quaternion());
    return [
      LOCAL_X.clone().applyQuaternion(rotation).normalize(),
      LOCAL_Y.clone().applyQuaternion(rotation).normalize(),
      LOCAL_Z.clone().applyQuaternion(rotation).normalize(),
    ];
  }

  private updateVisibility(): void {
    this.group.visible = this.visible && this.enabled && Boolean(this.controller.area) && !this.disposed;
  }

  private finishDrag(): void {
    this.session = null;
    this.setHovered(null);
    this.onDragStateChange?.(false, null);
  }
}

/** Convert a pointer position to normalized device coordinates for the gizmo APIs. */
export function drawingAreaGizmoPointerNdc(
  element: HTMLElement,
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
): THREE.Vector2 | null {
  return pointerNdc(element, event);
}

function pointerNdc(
  element: HTMLElement,
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
): THREE.Vector2 | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function planeHandleGeometry(a: THREE.Vector3, b: THREE.Vector3): THREE.BufferGeometry {
  const low = 0.14;
  const high = 0.34;
  const point = (x: number, y: number): number[] => a.clone().multiplyScalar(x).addScaledVector(b, y).toArray();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    ...point(low, low),
    ...point(high, low),
    ...point(high, high),
    ...point(low, high),
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function handleAxis(
  handle: DrawingAreaGizmoHandle,
  frame: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3],
): THREE.Vector3 | null {
  if (handle === 'axis-x') return frame[0].clone();
  if (handle === 'axis-y') return frame[1].clone();
  if (handle === 'axis-z') return frame[2].clone();
  return null;
}

function dragPlaneNormal(
  handle: DrawingAreaGizmoHandle,
  frame: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  rayDirection: THREE.Vector3,
  axis: THREE.Vector3 | null,
): THREE.Vector3 {
  if (axis) {
    const normal = rayDirection.clone().addScaledVector(axis, -rayDirection.dot(axis));
    if (normal.lengthSq() > EPSILON) return normal.normalize();
    return stablePerpendicular(axis);
  }
  if (handle === 'plane-xy') return frame[2].clone();
  if (handle === 'plane-xz') return frame[1].clone();
  if (handle === 'plane-yz') return frame[0].clone();
  return rayDirection.clone().normalize();
}

function stablePerpendicular(axis: THREE.Vector3): THREE.Vector3 {
  const candidate = Math.abs(axis.y) < 0.9 ? LOCAL_Y : LOCAL_X;
  return candidate.clone().addScaledVector(axis, -candidate.dot(axis)).normalize();
}

function pixelWorldSize(
  camera: THREE.Camera,
  origin: THREE.Vector3,
  viewportHeight: number,
  pixels: number,
): number {
  const height = Math.max(1, viewportHeight);
  if (camera instanceof THREE.OrthographicCamera) {
    return Math.max(1e-5, ((camera.top - camera.bottom) / camera.zoom) * pixels / height);
  }
  if (camera instanceof THREE.PerspectiveCamera) {
    const distance = camera.getWorldPosition(new THREE.Vector3()).distanceTo(origin);
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    return Math.max(1e-5, visibleHeight * pixels / height);
  }
  return 1;
}

function materialOf(object: THREE.Object3D): THREE.LineBasicMaterial | THREE.MeshBasicMaterial | null {
  if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return null;
  if (Array.isArray(object.material)) return null;
  if (object.material instanceof THREE.LineBasicMaterial) return object.material;
  if (object.material instanceof THREE.MeshBasicMaterial) return object.material;
  return null;
}

function vector(value: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}
