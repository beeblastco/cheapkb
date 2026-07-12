import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App";
import { Toaster } from "./components/ui/sonner";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark">
    <App />
    <Toaster position="bottom-right" richColors />
  </ThemeProvider>,
);
