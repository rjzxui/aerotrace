import type { FlightSession, TelemetrySample } from "./contracts.ts";
import type { FlightReportBundle } from "./flight-api.ts";

const DATABASE_NAME = "aerotrace-demo-archive";
const DATABASE_VERSION = 1;
const FLIGHT_STORE = "flights";

export type DemoArchiveEntry = {
  session: FlightSession;
  telemetry: TelemetrySample[];
  bundle: FlightReportBundle | null;
};

function openArchive(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FLIGHT_STORE)) {
        request.result.createObjectStore(FLIGHT_STORE, {
          keyPath: "session.sessionId",
        });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not open the demo flight archive."),
      );
    request.onblocked = () =>
      reject(
        new Error("The demo flight archive is blocked by another browser tab."),
      );
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openArchive().then((database) => {
    if (!database) {
      throw new Error(
        "This browser does not support persistent demo flight storage.",
      );
    }
    return new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(FLIGHT_STORE, mode);
      const request = action(transaction.objectStore(FLIGHT_STORE));
      let result: T | null = null;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () =>
        reject(
          request.error ??
            new Error("Could not access the demo flight archive."),
        );
      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
      transaction.onerror = () => {
        database.close();
        reject(
          transaction.error ??
            new Error("Could not commit the demo flight archive."),
        );
      };
      transaction.onabort = () => {
        database.close();
        reject(
          transaction.error ??
            new Error("The demo flight archive transaction was aborted."),
        );
      };
    });
  });
}

export async function saveDemoArchiveEntry(entry: DemoArchiveEntry) {
  await runTransaction("readwrite", (store) => store.put(entry));
}

export async function listDemoArchiveSessions(): Promise<FlightSession[]> {
  if (typeof indexedDB === "undefined") return [];
  const entries = await runTransaction<DemoArchiveEntry[]>(
    "readonly",
    (store) => store.getAll(),
  );
  return (entries ?? [])
    .map((entry) => entry.session)
    .sort(
      (left, right) =>
        Date.parse(right.startedAt ?? "") - Date.parse(left.startedAt ?? ""),
    );
}

export async function getDemoArchiveEntry(
  sessionId: string,
): Promise<DemoArchiveEntry | null> {
  if (typeof indexedDB === "undefined") return null;
  const entry = await runTransaction<DemoArchiveEntry>("readonly", (store) =>
    store.get(sessionId),
  );
  return entry ?? null;
}
