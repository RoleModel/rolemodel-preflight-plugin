import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

async function bootstrap() {
  if (new URLSearchParams(window.location.search).get("preview") === "1") {
    const { Preview } = await import("./Preview");
    ReactDOM.createRoot(document.querySelector("#root")!).render(
      <React.StrictMode>
        <Preview />
      </React.StrictMode>
    );
    return;
  }

  const [{ framer }, { App }] = await Promise.all([
    import("framer-plugin"),
    import("./App"),
  ]);

  if (framer.mode !== "syncManagedCollection") {
    void framer
      .showUI({
        height: 720,
        minHeight: 520,
        minWidth: 360,
        position: "top left",
        resizable: true,
        width: 420,
      })
      .catch(() => {
        // Direct browser opens do not have the Framer host bridge; render anyway.
      });
  }

  ReactDOM.createRoot(document.querySelector("#root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
