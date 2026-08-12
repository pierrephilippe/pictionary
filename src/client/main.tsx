import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const registerServiceWorker = (): void => {
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
};

if ("requestIdleCallback" in window) {
  window.requestIdleCallback(registerServiceWorker, { timeout: 1_500 });
} else {
  globalThis.setTimeout(registerServiceWorker, 1_000);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
