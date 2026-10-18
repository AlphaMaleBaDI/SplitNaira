"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { UnconfirmedSubmission } from "@/lib/submission-guard";

/**
 * Single-flight guard for payment and split actions (#1266).
 *
 * `run(action, task)` takes a synchronous lock (a ref, not React state), so a
 * double click, a repeated Enter press, or a retry fired before the next
 * render can't start a second submission. The lock is released when the task
 * settles, so controls come back after a definitive failure.
 *
 * An action marked unconfirmed (submitted, outcome unknown) stays blocked
 * until `clearUnconfirmed` is called, so a retry can't pay twice. While
 * anything is in flight or unconfirmed, leaving the page shows the browser's
 * "leave site?" prompt.
 */
export function useSubmissionGuard() {
  const inFlightRef = useRef(new Set<string>());
  const unconfirmedRef = useRef(new Map<string, UnconfirmedSubmission>());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [unconfirmed, setUnconfirmed] = useState<Readonly<Record<string, UnconfirmedSubmission>>>({});

  const syncInFlight = useCallback(() => setInFlight(new Set(inFlightRef.current)), []);
  const syncUnconfirmed = useCallback(
    () => setUnconfirmed(Object.fromEntries(unconfirmedRef.current)),
    [],
  );

  const run = useCallback(
    async <T>(action: string, task: () => Promise<T>): Promise<T | undefined> => {
      if (inFlightRef.current.has(action) || unconfirmedRef.current.has(action)) {
        return undefined;
      }
      inFlightRef.current.add(action);
      syncInFlight();
      try {
        return await task();
      } finally {
        inFlightRef.current.delete(action);
        syncInFlight();
      }
    },
    [syncInFlight],
  );

  const markUnconfirmed = useCallback(
    (action: string, submission: UnconfirmedSubmission) => {
      unconfirmedRef.current.set(action, submission);
      syncUnconfirmed();
    },
    [syncUnconfirmed],
  );

  const clearUnconfirmed = useCallback(
    (action: string) => {
      if (unconfirmedRef.current.delete(action)) syncUnconfirmed();
    },
    [syncUnconfirmed],
  );

  const isBlocked = useCallback(
    (action: string) => inFlight.has(action) || action in unconfirmed,
    [inFlight, unconfirmed],
  );

  const hasPendingWork = inFlight.size > 0 || Object.keys(unconfirmed).length > 0;

  useEffect(() => {
    if (!hasPendingWork) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required by some browsers to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasPendingWork]);

  return { run, isBlocked, inFlight, unconfirmed, markUnconfirmed, clearUnconfirmed, hasPendingWork };
}

export type SubmissionGuard = ReturnType<typeof useSubmissionGuard>;
