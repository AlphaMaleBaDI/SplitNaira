"use client";

import { useEffect, useState } from "react";

export type ConnectionStatus = "online" | "offline" | "reconnected";

/** How long the "Back online" confirmation stays visible. */
export const RECONNECTED_NOTICE_MS = 4_000;

function readOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Browser connectivity as a three-state value:
 * `offline` while the browser reports no network, `reconnected` briefly after
 * it comes back, then `online`. SSR and environments without `navigator`
 * report `online`.
 */
export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => (readOnline() ? "online" : "offline"));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const goOffline = () => {
      if (timer) clearTimeout(timer);
      setStatus("offline");
    };
    const goOnline = () => {
      setStatus((prev) => (prev === "offline" ? "reconnected" : "online"));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setStatus("online"), RECONNECTED_NOTICE_MS);
    };

    // Catch a change that happened between render and effect.
    if (!readOnline()) goOffline();

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return status;
}
