"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

function subscribeToConnectivity(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function getOfflineSnapshot() {
  return !navigator.onLine;
}

function getServerOfflineSnapshot() {
  return false;
}

export function PwaRegister() {
  const isOffline = useSyncExternalStore(
    subscribeToConnectivity,
    getOfflineSnapshot,
    getServerOfflineSnapshot,
  );
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let refreshed = false;
    const handleControllerChange = () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" })
      .then((registration) => {
        if (registration.waiting) setWaitingWorker(registration.waiting);

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setWaitingWorker(installing);
            }
          });
        });
      })
      .catch(() => {
        // The core interface still works when registration is blocked or unsupported.
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  if (!isOffline && !waitingWorker) return null;

  return (
    <aside className="pwa-status" aria-live="polite">
      {isOffline && (
        <p>
          <span aria-hidden="true">●</span>
          Offline · the installed sample menu remains available
        </p>
      )}
      {waitingWorker && (
        <button type="button" onClick={() => waitingWorker.postMessage({ type: "SKIP_WAITING" })}>
          Update LionLog
        </button>
      )}
    </aside>
  );
}
