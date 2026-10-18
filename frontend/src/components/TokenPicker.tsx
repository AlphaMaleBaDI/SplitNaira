"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { clsx } from "clsx";

import {
  KNOWN_TOKENS,
  getTokenDisplayName,
  getTokensByNetwork,
} from "@/lib/token-constants";

export interface TokenPickerProps {
  value: string;
  onChange: (token: string) => void;
  network: string | null;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  /** Fixed id for the token select, so an error summary can link to it (#1267). */
  id?: string;
}

function shortContract(contractId: string) {
  return `${contractId.slice(0, 6)}\u2026${contractId.slice(-6)}`;
}

export function TokenPicker({
  value,
  onChange,
  network,
  disabled = false,
  required = false,
  error,
  id,
}: TokenPickerProps) {
  const generatedSelectId = useId();
  const selectId = id ?? generatedSelectId;
  const customInputId = useId();
  const errorId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  // Track the element that had focus before the picker first received focus
  // so we can restore it when the user dismisses the picker via Escape.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const availableTokens = useMemo(() => getTokensByNetwork(network), [network]);
  const selectedToken = useMemo(
    () => KNOWN_TOKENS.find((token) => token.id === value),
    [value],
  );
  const [isCustom, setIsCustom] = useState(Boolean(value && !selectedToken));
  const [customToken, setCustomToken] = useState(selectedToken ? "" : value);
  const selectedValue = isCustom || (value && !selectedToken) ? "custom" : value;
  const tokenForValidation = isCustom ? customToken : value;
  const isCustomValid =
    !tokenForValidation ||
    StrKey.isValidEd25519PublicKey(tokenForValidation) ||
    StrKey.isValidContract(tokenForValidation);
  const errorMessage =
    error ??
    (customToken && !isCustomValid
      ? "Enter a valid Stellar token address."
      : undefined);

  const errorMessageId = errorMessage ? errorId : undefined;

  // Capture the previously active element the first time the picker
  // receives focus so Escape can restore it. We deliberately do this
  // on focus (not mount) so first-time focus via tab navigation is
  // captured before the picker steals focus. We rely on
  // `event.relatedTarget` rather than `document.activeElement` because
  // `activeElement` is updated synchronously *before* React's `focus`
  // handler runs, so reading it would give us the new focus target, not
  // the previous one.
  const handleFocusCapture = (
    event: React.FocusEvent<HTMLElement>,
  ) => {
    if (previouslyFocusedRef.current !== null) return;
    const related = event.relatedTarget as HTMLElement | null;
    if (related && related !== event.currentTarget) {
      previouslyFocusedRef.current = related;
    }
  };

  const restoreFocus = () => {
    const previous = previouslyFocusedRef.current;
    if (
      previous &&
      typeof previous.focus === "function" &&
      document.contains(previous)
    ) {
      previous.focus();
    }
  };

  useEffect(() => {
    return () => {
      // On unmount, restore focus to the element that triggered the picker
      // so screen-reader users don't lose their navigation context.
      restoreFocus();
    };
}, []);

  const handleSelectChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.target.value;
    if (nextValue === "custom") {
      setIsCustom(true);
      setCustomToken(selectedToken ? "" : value);
      return;
    }

    setIsCustom(false);
    setCustomToken("");
    onChange(nextValue);
  };

  const handleCustomChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    setCustomToken(nextValue);
    onChange(nextValue);
  };

  // Escape: native <select> does not have a portable Escape-to-close
  // behaviour across browsers. We treat Escape as "clear current selection
  // and return focus to where the user was before the picker" so keyboard
  // users have a deterministic, documented way to back out.
  const handlePickerKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key !== "Escape") return;

    event.preventDefault();
    event.stopPropagation();

    if (value || isCustom || customToken) {
      setIsCustom(false);
      setCustomToken("");
      onChange("");
    }

    restoreFocus();
  };

  const hasError = Boolean(errorMessage);
  const requiredMark = required ? (
    <span className="ml-1 text-red-400" aria-hidden="true">
      *
    </span>
  ) : null;

  return (
    <div
      className="space-y-3 md:col-span-2"
      aria-disabled={disabled || undefined}
    >
      <div className="space-y-2">
        <label
          htmlFor={selectId}
          className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted px-1"
        >
          Asset Token
          {requiredMark}
        </label>
        <select
          ref={selectRef}
          id={selectId}
          value={selectedValue}
          onChange={handleSelectChange}
          onKeyDown={handlePickerKeyDown}
          onFocus={handleFocusCapture}
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-invalid={hasError || undefined}
          aria-describedby={errorMessageId}
          aria-label={`Asset token${network ? ` for ${network}` : ""}`}
          className={clsx(
            "glass-input w-full rounded-2xl px-5 py-4 text-sm cursor-pointer",
            hasError ? "border-red-500/50 bg-red-500/5" : "",
          )}
        >
          <option value="">Select a token\u2026</option>
          {availableTokens.map((token) => (
            <option
              key={`${token.network}-${token.code}-${token.id}`}
              value={token.id}
            >
              {token.code} \u2014 {token.name} ({token.network}) \u00b7{" "}
              {shortContract(token.id)}
            </option>
          ))}
          <option value="custom">Custom\u2026</option>
        </select>
      </div>

      {isCustom && (
        <div className="space-y-2">
          <label
            htmlFor={customInputId}
            className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted/70 px-1"
          >
            Custom token contract
          </label>
          <input
            ref={customInputRef}
            id={customInputId}
            type="text"
            value={customToken}
            onChange={handleCustomChange}
            onKeyDown={handlePickerKeyDown}
            onFocus={handleFocusCapture}
            disabled={disabled}
            required={required && isCustom}
            aria-required={(required && isCustom) || undefined}
            aria-invalid={hasError || undefined}
            aria-describedby={errorMessageId}
            placeholder="Paste a Stellar contract address, e.g. C\u2026"
            className={clsx(
              "glass-input w-full rounded-2xl px-5 py-4 font-mono text-sm",
              hasError ? "border-red-500/50 bg-red-500/5" : "",
            )}
          />
        </div>
      )}

      {value && !isCustom && (
        <div className="rounded-2xl border border-white/5 bg-white/2 p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">
            Selected Token
          </p>
          <p className="break-all font-mono text-sm text-ink" aria-live="polite">
            {getTokenDisplayName(value)}
          </p>
        </div>
      )}

      {errorMessage && (
        <p
          id={errorId}
          role={error ? "alert" : undefined}
          className="px-1 text-[10px] font-bold text-red-400 uppercase tracking-tighter"
        >
          {errorMessage}
        </p>
      )}
    </div>
  );
}
