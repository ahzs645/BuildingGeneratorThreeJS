import { useEffect, useRef } from "react";
import {
  bindSearchableSelect,
  type SearchableOption,
  type SearchableSelectBinding,
} from "./searchable-select";

export type { SearchableOption } from "./searchable-select";

export interface SearchableSelectProps {
  /**
   * The input's id. Imperative runtimes address the field by it, the way they
   * addressed the `<select>` this replaces, so it is required rather than
   * generated.
   */
  id: string;
  /**
   * The accessible name. There is no `<label for>` at any of the call sites —
   * /typewriter's "Base object" was a sibling `.st-section-title`, which is
   * why its combobox announced 105 options under no name at all — so the name
   * is carried on the control itself.
   */
  label: string;
  /**
   * The catalogue, when React owns it. Omit it and the markup is left inert
   * for a runtime to drive through `bindSearchableSelect`.
   */
  options?: readonly SearchableOption[];
  value?: string;
  onSelect?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The studio's picker for a list too long to scroll: a text field over a
 * datalist, flanked by prev/next. See searchable-select.ts for why all three
 * catalogue tools share one.
 */
export function SearchableSelect({
  id,
  label,
  options,
  value,
  onSelect,
  placeholder = "Search…",
  disabled,
  className,
}: SearchableSelectProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const bindingRef = useRef<SearchableSelectBinding | null>(null);
  const selectRef = useRef(onSelect);
  const reactDriven = options !== undefined;

  useEffect(() => { selectRef.current = onSelect; });
  // Binding only when React holds the catalogue: where a runtime holds it, the
  // runtime binds this same helper, and two bindings on one field would each
  // answer the other's writes.
  useEffect(() => {
    const input = inputRef.current;
    if (!reactDriven || !input) return;
    const binding = bindSearchableSelect(input, (next) => selectRef.current?.(next));
    bindingRef.current = binding;
    return () => {
      bindingRef.current = null;
      binding.dispose();
    };
  }, [reactDriven]);
  useEffect(() => { if (options) bindingRef.current?.setOptions(options); }, [options]);
  useEffect(() => { if (value !== undefined) bindingRef.current?.setValue(value); }, [options, value]);

  const step = (direction: "-1" | "1", name: string): React.JSX.Element => <button
    className="st-btn"
    type="button"
    data-searchable-step={direction}
    disabled={disabled}
    aria-label={`${name} ${label.toLocaleLowerCase()}`}
    title={name}
  >{direction === "-1" ? "←" : "→"}</button>;

  return <div className={`st-searchable${className ? ` ${className}` : ""}`} data-searchable>
    {step("-1", "Previous")}
    <input
      id={id}
      className="st-input"
      type="text"
      list={`${id}-options`}
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      ref={inputRef}
    />
    {/* Filled by whichever side owns the catalogue; never by React, so the
        picker has one code path for 104 options however they arrive. */}
    <datalist id={`${id}-options`} />
    {step("1", "Next")}
  </div>;
}

export default SearchableSelect;
