/**
 * The searchable picker: one text field over a `<datalist>`, with prev/next
 * either side.
 *
 * Three tools front the same 104-entry shape catalogue — /typewriter's base
 * object, /paint's reference object, /chrome-assets' ported asset — and two of
 * them fronted it with a native `<select>`, i.e. a 105-option list with no way
 * to type at it and, on a phone, a full-screen wheel. /chrome-assets had
 * already solved it; this is that solution, in one place instead of three.
 *
 * The behaviour lives here rather than in the React component because two of
 * the three call sites are imperative runtimes that own their own DOM. The
 * component (SearchableSelect.tsx) renders the markup and drives this same
 * binding for the one call site that is React-controlled, so there is a single
 * implementation of matching, stepping and the value contract.
 */

export interface SearchableOption {
  /** What the tool stores and reads back — an asset or shape id. */
  readonly value: string;
  /** What the field shows and the datalist offers. */
  readonly label: string;
}

export interface SearchableSelectBinding {
  /** Replace the catalogue. Catalogues arrive from the network, so this is called late. */
  setOptions(options: readonly SearchableOption[]): void;
  /** Show a value without announcing it — for a selection the tool made itself. */
  setValue(value: string): void;
  getValue(): string;
  dispose(): void;
}

/**
 * Typed text names an option by its label or by its id, case- and
 * whitespace-insensitively. Anything else is not a selection: a half-typed
 * word must not commit the one asset that happens to match it so far.
 */
export function matchSearchableOption(
  options: readonly SearchableOption[],
  text: string,
): SearchableOption | undefined {
  const normalized = text.trim().toLocaleLowerCase();
  return options.find((option) => option.label.toLocaleLowerCase() === normalized)
    ?? options.find((option) => option.value.toLocaleLowerCase() === normalized);
}

/** Prev/next wrap around, so neither arrow is ever a dead button. */
export function stepSearchableOption(
  options: readonly SearchableOption[],
  value: string,
  direction: -1 | 1,
): SearchableOption | undefined {
  if (!options.length) return undefined;
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return options[(index + direction + options.length) % options.length];
}

/**
 * Wire an input rendered by SearchableSelect. The prev/next buttons are found
 * through the wrapper's `data-searchable` marker and the datalist through the
 * input's own `list` attribute, so a caller passes only the field it owns.
 */
export function bindSearchableSelect(
  input: HTMLInputElement,
  onSelect: (value: string) => void,
): SearchableSelectBinding {
  const list = input.list;
  const steppers = [...(input.closest("[data-searchable]")
    ?.querySelectorAll<HTMLButtonElement>("[data-searchable-step]") ?? [])];
  let options: readonly SearchableOption[] = [];
  let selected = "";

  const current = (): SearchableOption | undefined => options.find((option) => option.value === selected);
  const show = (option: SearchableOption | undefined): void => {
    input.value = option?.label ?? "";
    // Catalogue labels are "Collection · Name" and run past the field width;
    // the tooltip is how the tail stays reachable without focusing the input.
    input.title = option?.label ?? "";
  };
  const commit = (option: SearchableOption | undefined): void => {
    if (!option || option.value === selected) return;
    selected = option.value;
    show(option);
    onSelect(option.value);
  };

  const onInput = (): void => commit(matchSearchableOption(options, input.value));
  // Focus selects the text so the next keystroke searches the whole catalogue
  // rather than appending to the name already in the field.
  const onFocus = (): void => input.select();
  // Text that names nothing is ignored, but leaving it in the field would have
  // the control misreport what the tool is actually showing.
  const onBlur = (): void => show(current());
  const onStep = (event: Event): void => {
    const direction = Number((event.currentTarget as HTMLElement).dataset.searchableStep);
    commit(stepSearchableOption(options, selected, direction === -1 ? -1 : 1));
  };

  input.addEventListener("input", onInput);
  input.addEventListener("change", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  for (const stepper of steppers) stepper.addEventListener("click", onStep);

  return {
    setOptions(next) {
      options = next;
      list?.replaceChildren(...next.map((option) => {
        const element = document.createElement("option");
        element.value = option.label;
        // The picker's own value is the id; Chromium shows it as the hint
        // beside the label, which is how a URL-shared id stays recognisable.
        if (option.value) element.label = option.value;
        return element;
      }));
      // A catalogue that arrives after the tool has restored a selection has to
      // fill the field it could not name yet.
      const option = current();
      if (option) show(option);
    },
    setValue(value) {
      selected = value;
      show(current());
    },
    getValue: () => selected,
    dispose() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("change", onInput);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      for (const stepper of steppers) stepper.removeEventListener("click", onStep);
    },
  };
}
