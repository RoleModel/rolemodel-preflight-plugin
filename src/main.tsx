import { framer } from "framer-plugin";
// oxlint-disable require-await
import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";

import "./styles.css";

async function bootstrap() {
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
