import type { JSX, KeyboardEvent, PointerEvent } from "react";
import { rangeFillStyle } from "../studio/range-fill";

type StudioRangeInputProps = {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  preserveExactValue?: boolean;
  onValue: (value: number) => void;
};

function finiteStep(min: number, max: number, step: number): number {
  if (Number.isFinite(step) && step > 0) return step;
  const span = max - min;
  return Number.isFinite(span) && span > 0 ? span / 100 : 1;
}

/**
 * Step an authored Blender value without first snapping it to the HTML range
 * grid. Blender defaults often carry more precision than the inspector's
 * generated UI step, and losing that precision before the first edit makes a
 * controlled range disagree with its own readout.
 */
export function steppedStudioRangeValue(
  value: number,
  min: number,
  max: number,
  step: number,
  direction: -1 | 1,
  multiplier = 1,
): number {
  const delta = finiteStep(min, max, step) * multiplier * direction;
  const next = Number((value + delta).toPrecision(15));
  return Math.min(max, Math.max(min, next));
}

export function studioRangeValueAtPointer(
  clientX: number,
  left: number,
  width: number,
  min: number,
  max: number,
  step: number,
  preserveExactValue: boolean,
): number {
  const ratio = width > 0
    ? Math.min(1, Math.max(0, (clientX - left) / width))
    : 0;
  const raw = min + (max - min) * ratio;
  if (preserveExactValue) return raw;
  const increment = finiteStep(min, max, step);
  const snapped = min + Math.round((raw - min) / increment) * increment;
  return Math.min(max, Math.max(min, Number(snapped.toPrecision(15))));
}

/**
 * Range input tuned for controlled React state and imported Blender values.
 * `onInput` covers pointer drags and browser automation consistently, while
 * the explicit key handler keeps arrows useful when `step="any"` is required
 * to preserve an authored value that is not aligned to the generated step.
 */
export function StudioRangeInput({
  label,
  min,
  max,
  step,
  value,
  disabled,
  preserveExactValue = false,
  onValue,
}: StudioRangeInputProps): JSX.Element {
  const commit = (next: number): void => {
    if (!Number.isFinite(next)) return;
    onValue(Math.min(max, Math.max(min, next)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    let next: number | undefined;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = steppedStudioRangeValue(value, min, max, step, -1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = steppedStudioRangeValue(value, min, max, step, 1);
    } else if (event.key === "PageDown") {
      next = steppedStudioRangeValue(value, min, max, step, -1, 10);
    } else if (event.key === "PageUp") {
      next = steppedStudioRangeValue(value, min, max, step, 1, 10);
    }
    if (next === undefined) return;
    event.preventDefault();
    commit(next);
  };
  const commitInput = (input: HTMLInputElement): void => commit(input.valueAsNumber);
  const commitPointer = (event: PointerEvent<HTMLInputElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    commit(studioRangeValueAtPointer(
      event.clientX,
      bounds.left,
      bounds.width,
      min,
      max,
      step,
      preserveExactValue,
    ));
  };

  return <input
    aria-label={label}
    type="range"
    min={min}
    max={max}
    step={preserveExactValue ? "any" : finiteStep(min, max, step)}
    value={value}
    style={rangeFillStyle(value, min, max)}
    disabled={disabled}
    onInput={(event) => commitInput(event.currentTarget)}
    onChange={(event) => commitInput(event.currentTarget)}
    onKeyDown={onKeyDown}
    onPointerDown={(event) => {
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      commitPointer(event);
    }}
    onPointerMove={(event) => {
      if (!(event.buttons & 1)) return;
      event.preventDefault();
      commitPointer(event);
    }}
  />;
}
