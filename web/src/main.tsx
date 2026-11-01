import { createRoot } from "react-dom/client";
import App from "./App";
import { SHOO_CALLBACK_PATH } from "./lib/client";
import { enablePostHog, posthog } from "./lib/posthog";
import "./index.css";

// The sign-in callback, whose URL holds the auth code, loads no analytics. The
// no-external build keeps script-src 'self', so uncaught errors are forwarded here.
if (window.location.pathname !== SHOO_CALLBACK_PATH) {
  enablePostHog();
  window.addEventListener("error", (event): void => {
    posthog.captureException(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event): void => {
    posthog.captureException(event.reason);
  });
}

createRoot(document.getElementById("root")!).render(<App />);
