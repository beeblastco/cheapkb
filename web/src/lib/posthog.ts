import type { PostHog } from "posthog-js/dist/module.no-external";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
// The longest a user action such as sign-in waits for a slow PostHog download.
const CAPTURE_NOW_WAIT_MS = 1000;
// Where PostHog keeps the visitor's ids and person properties; it uses no cookie.
const PERSISTENCE_KEY = `ph_${POSTHOG_KEY}_posthog`;

let release = (): void => {};
// Resolves once the first screen has rendered, or sooner for a call that cannot wait.
const released = new Promise<void>((resolve) => {
  release = resolve;
});
let client: Promise<PostHog | null> | undefined;
let loadedClient: PostHog | null = null;

/** The PostHog calls the app makes; calls before PostHog loads wait for it, in order.
 * captureNow loads it at once and waits at most a second; reset never waits. */
export const posthog = {
  capture: (...args: Parameters<PostHog["capture"]>): void => {
    void withPostHog((loaded) => loaded.capture(...args));
  },
  captureException: (
    ...args: Parameters<PostHog["captureException"]>
  ): void => {
    void withPostHog((loaded) => loaded.captureException(...args));
  },
  captureNow: (...args: Parameters<PostHog["capture"]>): Promise<void> => {
    loadPostHog();

    return Promise.race([
      withPostHog((loaded) => loaded.capture(...args)),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, CAPTURE_NOW_WAIT_MS);
      }),
    ]);
  },
  identify: (...args: Parameters<PostHog["identify"]>): void => {
    void withPostHog((loaded) => loaded.identify(...args));
  },
  // Forgets the user on this browser at once, loaded or not, so the next visitor is never linked to them.
  reset: (): void => {
    if (!POSTHOG_KEY) return;
    localStorage.removeItem(PERSISTENCE_KEY);
    loadedClient?.reset();
  },
};

/** Turns analytics on for this page. main.tsx calls it, except on the sign-in
 * callback; without a key the build has no PostHog chunk at all. */
export function enablePostHog(): void {
  if (!POSTHOG_KEY || client) return;
  client = released.then(importPostHog);
}

/** Lets PostHog load. Guest and Workspace call it once mounted, so its download
 * never competes with the workspace chunk; a no-op until enablePostHog. */
export function loadPostHog(): void {
  release();
}

/** Imports and initializes PostHog; null when the chunk is blocked or fails. */
async function importPostHog(): Promise<PostHog | null> {
  try {
    const { default: loaded } =
      await import("posthog-js/dist/module.no-external");
    // Text is masked so analytics never records document content.
    loaded.init(POSTHOG_KEY, {
      api_host: import.meta.env.VITE_POSTHOG_HOST,
      autocapture: { capture_copied_text: false },
      defaults: "2026-08-30",
      mask_all_element_attributes: true,
      mask_all_text: true,
      persistence: "localStorage",
      person_profiles: "identified_only",
    });
    loadedClient = loaded;

    return loaded;
  } catch {
    return null;
  }
}

/** Runs a call once PostHog has loaded; a no-op when analytics is off. */
async function withPostHog(call: (loaded: PostHog) => void): Promise<void> {
  const loaded = await client;
  if (loaded) call(loaded);
}
