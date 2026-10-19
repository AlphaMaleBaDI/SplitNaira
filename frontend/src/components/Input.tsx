"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { clsx } from "clsx";

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Label rendered above the input */
  label?: string;
  /** Error message rendered below the input */
  error?: string;
  /** Helper text rendered below the input (shown only when there is no error) */
  hint?: string;
  /** Leading icon or adornment rendered inside the input on the left */
  leading?: React.ReactNode;
  /** Trailing icon or adornment rendered inside the input on the right */
  trailing?: React.ReactNode;
  size?: InputSize;
  fullWidth?: boolean;
}

const sizeClasses: Record<InputSize, { wrapper: string; input: string }> = {
  sm: { wrapper: "h-8", input: "text-sm px-2.5" },
  md: { wrapper: "h-10", input: "text-sm px-3" },
  lg: { wrapper: "h-12", input: "text-base px-4" },
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      leading,
      trailing,
      size = "md",
      fullWidth = false,
      className,
      id,
      disabled,
      ...props
    },
    ref,
  ) => {
    const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
    const hasError = Boolean(error);
    const { wrapper, input } = sizeClasses[size];

    return (
      <div className={clsx("flex flex-col gap-1", fullWidth && "w-full")}>
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-gray-700"
          >
            {label}
          </label>
        )}
        <div
          className={clsx(
            "relative flex items-center rounded-lg border bg-white transition-colors",
            wrapper,
            hasError
              ? "border-red-400 focus-within:ring-2 focus-within:ring-red-400 focus-within:ring-offset-1"
              : "border-gray-300 focus-within:ring-2 focus-within:ring-violet-500 focus-within:ring-offset-1",
            disabled && "bg-gray-50 opacity-60 cursor-not-allowed",
          )}
        >
          {leading && (
            <span className="pointer-events-none pl-3 text-gray-400">{leading}</span>
          )}
          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            aria-invalid={hasError}
            aria-describedby={
              hasError ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
            }
            className={clsx(
              "flex-1 bg-transparent outline-none placeholder-gray-400",
              "disabled:cursor-not-allowed",
              input,
              leading && "pl-1.5",
              trailing && "pr-1.5",
              className,
            )}
            {...props}
          />
          {trailing && (
            <span className="pointer-events-none pr-3 text-gray-400">{trailing}</span>
          )}
        </div>
        {hasError && (
          <p id={`${inputId}-error`} role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
        {!hasError && hint && (
          <p id={`${inputId}-hint`} className="text-xs text-gray-500">
            {hint}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
