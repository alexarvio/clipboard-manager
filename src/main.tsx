import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Dashboard from "./components/Dashboard";
import { getCurrentWindow, isTauri } from "./lib/tauriShim";
import "./styles.css";

// Clip has two separate windows (see the two entries in
// src-tauri/tauri.conf.json): "main" is the docked quick-access panel
// toggled by the global hotkey, and "dashboard" is the full-size Insights/
// account window opened by clicking the tray icon (see open_dashboard in
// main.rs). Both load this same index.html/bundle, so which one to render
// is decided at runtime by the window's label.
const windowLabel = getCurrentWindow().label;

// In the real app, the "main" window itself *is* the panel -- Rust docks it
// to the left edge of the screen at ~1/5 monitor width, full height (see
// dock_to_left_edge in main.rs). A plain browser tab has no such window, so
// without this wrapper the panel stretches to fill the entire browser
// viewport, which looks nothing like what a real user sees. This recreates
// that context for visual review: a simulated desktop behind a left-docked
// panel sized the same way the production window is.
function Root() {
  if (isTauri) return <App />;

  return (
    <div className="fixed inset-0 overflow-hidden">
      <div
        className="absolute inset-0 dark:hidden"
        style={{ background: "linear-gradient(145deg,#dce8f8 0%,#c8d8ec 55%,#e2dcf5 100%)" }}
      />
      <div
        className="absolute inset-0 hidden dark:block"
        style={{ background: "linear-gradient(145deg,#0f0c18 0%,#1b1530 50%,#0c1828 100%)" }}
      />
      <div className="absolute inset-y-0 left-0" style={{ width: "clamp(320px, 20vw, 480px)" }}>
        <App />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {windowLabel === "dashboard" ? <Dashboard /> : <Root />}
  </React.StrictMode>
);
