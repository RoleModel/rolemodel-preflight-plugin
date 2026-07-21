import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

const getRootElement = (): Element => {
  const element = document.querySelector("#root");
  if (!element) {
    throw new Error("Could not find #root element to mount into.");
  }
  return element;
};

const bootstrap = async () => {
  if (new URLSearchParams(window.location.search).get("preview") === "1") {
    const { Preview } = await import("./preview");
    ReactDOM.createRoot(getRootElement()).render(
      <React.StrictMode>
        <Preview />
      </React.StrictMode>
    );
    return;
  }

  const [{ framer }, { App }] = await Promise.all([
    import("@framer/plugin"),
    import("./app"),
  ]);

  if (framer.mode !== "syncManagedCollection") {
    void (async () => {
      try {
        await framer.showUI({
          height: 720,
          minHeight: 520,
          minWidth: 450,
          position: "top left",
          resizable: true,
          width: 520,
        });
      } catch {
        // Direct browser opens do not have the Framer host bridge; render anyway.
      }
    })();
  }

  ReactDOM.createRoot(getRootElement()).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
};

void bootstrap();
