import type { SurfaceGeneratorId } from './contracts';
import type { SurfaceGeneratorAdapter } from './generator-adapter';
import type { SurfaceStudioHost } from './app-host';
import type { SurfaceInputHooks } from './surface-input-controller';
import { SurfaceStudioRuntime } from './surface-studio-runtime';

export interface AttachedSurfaceStudioRuntime {
  readonly runtime: SurfaceStudioRuntime;
  dispose(): void;
}

/**
 * Mount the renderer-neutral studio coordinator into the procedural App host.
 * The final cutover can use this one seam instead of giving shared systems the
 * entire legacy App instance.
 */
export function attachSurfaceStudioRuntime(
  host: SurfaceStudioHost,
  adapters: readonly SurfaceGeneratorAdapter<any>[],
  activeGenerator: SurfaceGeneratorId = 'ivy',
  inputHooks?: SurfaceInputHooks,
): AttachedSurfaceStudioRuntime {
  const runtime = new SurfaceStudioRuntime({
    element: host.canvas,
    camera: host.camera,
    orbitControls: host.controls,
    targetRoot: host.modelRoot,
    managerHost: {
      scene: host.scene,
      camera: host.camera,
      outputParent: host.outputParent,
      surfaceRoot: host.modelRoot,
      compile: (object) => host.compile(object),
      setStatus: (state, message) => host.setStatus(state, message),
    },
    adapters,
    activeGenerator,
    inputHooks,
  });
  let disposed = false;
  let lastRevision = -1;
  const unsubscribeSurface = host.subscribeSurface(({ root, revision }) => {
    if (disposed || revision === lastRevision) return;
    lastRevision = revision;
    void runtime.replaceSurface(root, revision);
  });
  const unregisterFrame = host.registerFrameTask((dt, elapsed) => runtime.update(dt, elapsed));

  return {
    runtime,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unregisterFrame();
      unsubscribeSurface();
      runtime.dispose();
    },
  };
}
