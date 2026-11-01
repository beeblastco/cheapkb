import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.no-external";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SHOO_CALLBACK_PATH } from "./lib/client";
import "./index.css";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;

const queryClient = new QueryClient();

// The no-external build keeps script-src 'self', so uncaught errors are forwarded here.
// Text is masked and the sign-in callback, whose URL holds the auth code, is skipped.
if (POSTHOG_KEY && window.location.pathname !== SHOO_CALLBACK_PATH) {
  posthog.init(POSTHOG_KEY, {
    api_host: import.meta.env.VITE_POSTHOG_HOST,
    autocapture: { capture_copied_text: false },
    defaults: "2026-08-30",
    mask_all_element_attributes: true,
    mask_all_text: true,
    person_profiles: "identified_only",
  });
  window.addEventListener("error", (event): void => {
    posthog.captureException(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event): void => {
    posthog.captureException(event.reason);
  });
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
