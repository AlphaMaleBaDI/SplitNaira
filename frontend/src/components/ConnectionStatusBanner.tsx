"use client";

import { CheckCircle2, WifiOff } from "lucide-react";

import type { ConnectionStatus } from "@/hooks/useConnectionStatus";

interface ConnectionStatusBannerProps {
  status: ConnectionStatus;
  className?: string;
}

/**
 * Announces connectivity changes without stealing focus.
 *
 * The live region is always mounted so screen readers pick up changes
 * (a region inserted together with its text is often not announced). It is a
 * polite `status`, never an alert, and holds no focusable controls, so
 * keyboard users keep their place in the form.
 */
export function ConnectionStatusBanner({ status, className }: Readonly<ConnectionStatusBannerProps>) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={className}>
      {status === "offline" && (
        <div
          data-testid="connection-offline"
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-semibold">You&apos;re offline.</span> What you&apos;ve typed is kept on
            this device. Nothing will be submitted until you&apos;re back online.
          </p>
        </div>
      )}
      {status === "reconnected" && (
        <div
          data-testid="connection-reconnected"
          className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-semibold">Back online.</span> You can continue where you left off.
          </p>
        </div>
      )}
    </div>
  );
}
