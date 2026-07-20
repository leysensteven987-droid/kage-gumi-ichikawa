import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import IchikawaSurface from "./IchikawaSurface.jsx";
createRoot(document.getElementById("root")).render(
  <StrictMode><IchikawaSurface /></StrictMode>
);
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
