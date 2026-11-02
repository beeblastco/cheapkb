import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let now = currentMinute();
let timer: number | undefined;

/** The current time floored to the minute, for checks that age with the clock in
 * memoized rows. One timer serves every subscriber; `live` false skips the ticks. */
export function useNowMinute(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : ignore, getSnapshot);
}

/** Now, floored to the minute; the snapshot every subscriber shares. */
function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** Snapshot for useSyncExternalStore; refreshed on read only while no timer keeps it current. */
function getSnapshot(): number {
  if (timer === undefined) now = currentMinute();

  return now;
}

/** Subscribe for rows that never age with the clock: no timer, nothing to clean up. */
function ignore(): () => void {
  return () => {};
}

/** Arms the one shared timer for the next minute boundary. */
function schedule(): void {
  timer = window.setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS));
}

/** Adds a live row; the first one starts the timer and the last one to leave stops it. */
function subscribe(listener: () => void): () => void {
  if (!listeners.size) {
    now = currentMinute();
    schedule();
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    window.clearTimeout(timer);
    timer = undefined;
  };
}

/** Advances the minute, notifies every live row, and re-arms while any remain. */
function tick(): void {
  timer = undefined;
  now = currentMinute();
  for (const listener of listeners) listener();
  if (listeners.size && timer === undefined) schedule();
}
