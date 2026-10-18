"use client";

import { forwardRef, useId } from "react";

export interface FormErrorSummaryItem {
  /** `id` of the field the error belongs to; the summary link focuses it. */
  fieldId: string;
  message: string;
}

interface FormErrorSummaryProps {
  errors: FormErrorSummaryItem[];
  title?: string;
}

/**
 * Lists every validation error in a form, each linking to its field (#1267).
 *
 * The parent moves focus here after a failed submit with more than one
 * error. The container is focusable (`tabIndex={-1}`) and labelled by its
 * heading, so screen readers announce "There are N problems…" on focus, and
 * each link moves focus straight to the field to fix.
 */
export const FormErrorSummary = forwardRef<HTMLDivElement, FormErrorSummaryProps>(
  function FormErrorSummary({ errors, title }, ref) {
    const headingId = useId();
    if (errors.length === 0) return null;

    const heading = title ?? `There ${errors.length === 1 ? "is 1 problem" : `are ${errors.length} problems`} with this form`;

    return (
      <div
        ref={ref}
        tabIndex={-1}
        aria-labelledby={headingId}
        data-testid="form-error-summary"
        className="rounded-2xl border border-red-500/40 bg-red-500/10 p-5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-red-400"
      >
        <h2 id={headingId} className="font-semibold text-red-300">
          {heading}
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          {errors.map((error) => (
            <li key={`${error.fieldId}:${error.message}`}>
              <a
                href={`#${error.fieldId}`}
                onClick={(event) => {
                  const field = document.getElementById(error.fieldId);
                  if (!field) return;
                  event.preventDefault();
                  field.focus();
                  field.scrollIntoView?.({ block: "center" });
                }}
                className="text-red-200 underline underline-offset-2 hover:text-red-100"
              >
                {error.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  },
);
