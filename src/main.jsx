import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import IchikawaSurface from "./IchikawaSurface.jsx";
createRoot(document.getElementById("root")).render(
  <StrictMode><IchikawaSurface /></StrictMode>
);
// iOS Safari ignores user-scalable=no in the viewport meta, so pinch-zoom has to
// be refused by hand. Non-standard `gesture*` events; harmless no-ops elsewhere.
for (const evt of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(evt, e => e.preventDefault(), { passive: false });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
