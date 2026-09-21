/**
 * IndexedDB schema (idb). Shared by the service worker (writer) and extension
 * pages (report reads). Typed arrays and Blobs are stored via structured clone.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AOI,
  CalibrationModelRecord,
  PageVisit,
  SampleChunk,
  ScreenshotTile,
  Session,
  SessionEvent,
  Study,
} from '@red-tracking/protocol';

export interface SettingsRecord {
  key: string;
  value: unknown;
}

export interface RTDB extends DBSchema {
  studies: { key: string; value: Study; indexes: { byCreated: number } };
  sessions: { key: string; value: Session; indexes: { byCreated: number; byStudy: string } };
  pageVisits: { key: string; value: PageVisit; indexes: { bySession: string } };
  calibrations: { key: string; value: CalibrationModelRecord; indexes: { bySession: string } };
  chunks: {
    key: string;
    value: SampleChunk;
    indexes: { bySession: string; byVisit: [string, string, number] };
  };
  tiles: { key: string; value: ScreenshotTile; indexes: { bySession: string; byVisit: [string, string] } };
  aois: { key: string; value: AOI; indexes: { bySession: string; byVisit: string } };
  events: { key: number; value: SessionEvent; indexes: { bySession: string } };
  settings: { key: string; value: SettingsRecord };
}

export const DB_NAME = 'redtracking';
export const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<RTDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<RTDB>> {
  if (!dbPromise) {
    dbPromise = openDB<RTDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const studies = db.createObjectStore('studies', { keyPath: 'id' });
        studies.createIndex('byCreated', 'createdAt');

        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('byCreated', 'createdAt');
        sessions.createIndex('byStudy', 'studyId');

        const visits = db.createObjectStore('pageVisits', { keyPath: 'id' });
        visits.createIndex('bySession', 'sessionId');

        const cal = db.createObjectStore('calibrations', { keyPath: 'id' });
        cal.createIndex('bySession', 'sessionId');

        const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
        chunks.createIndex('bySession', 'sessionId');
        chunks.createIndex('byVisit', ['sessionId', 'pageVisitId', 'tStart']);

        const tiles = db.createObjectStore('tiles', { keyPath: 'id' });
        tiles.createIndex('bySession', 'sessionId');
        tiles.createIndex('byVisit', ['sessionId', 'pageVisitId']);

        const aois = db.createObjectStore('aois', { keyPath: 'id' });
        aois.createIndex('bySession', 'sessionId');
        aois.createIndex('byVisit', 'pageVisitId');

        const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        events.createIndex('bySession', 'sessionId');

        db.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const rec = await db.get('settings', key);
  return rec ? (rec.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('settings', { key, value });
}

/** Everything belonging to one session, for the report page and exports. */
export interface SessionBundle {
  session: Session;
  pageVisits: PageVisit[];
  calibration: CalibrationModelRecord | null;
  chunks: SampleChunk[];
  tiles: ScreenshotTile[];
  aois: AOI[];
  events: SessionEvent[];
}

export async function loadSessionBundle(sessionId: string): Promise<SessionBundle | null> {
  const db = await getDb();
  const session = await db.get('sessions', sessionId);
  if (!session) return null;
  const [pageVisits, calibrations, chunks, tiles, aois, events] = await Promise.all([
    db.getAllFromIndex('pageVisits', 'bySession', sessionId),
    db.getAllFromIndex('calibrations', 'bySession', sessionId),
    db.getAllFromIndex('chunks', 'bySession', sessionId),
    db.getAllFromIndex('tiles', 'bySession', sessionId),
    db.getAllFromIndex('aois', 'bySession', sessionId),
    db.getAllFromIndex('events', 'bySession', sessionId),
  ]);
  pageVisits.sort((a, b) => a.tStart - b.tStart);
  chunks.sort((a, b) => a.tStart - b.tStart);
  tiles.sort((a, b) => a.t - b.t);
  events.sort((a, b) => a.t - b.t);
  const calibration = session.calibrationId
    ? calibrations.find((c) => c.id === session.calibrationId) ?? calibrations.at(-1) ?? null
    : calibrations.at(-1) ?? null;
  return { session, pageVisits, calibration, chunks, tiles, aois, events };
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'pageVisits', 'calibrations', 'chunks', 'tiles', 'aois', 'events'], 'readwrite');
  const stores = ['pageVisits', 'calibrations', 'chunks', 'tiles', 'aois'] as const;
  for (const s of stores) {
    const keys = await tx.objectStore(s).index('bySession').getAllKeys(sessionId);
    for (const k of keys) await tx.objectStore(s).delete(k);
  }
  const evKeys = await tx.objectStore('events').index('bySession').getAllKeys(sessionId);
  for (const k of evKeys) await tx.objectStore('events').delete(k);
  await tx.objectStore('sessions').delete(sessionId);
  await tx.done;
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('sessions', 'byCreated');
  return all.reverse();
}
