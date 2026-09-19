import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "highlight.js/styles/github.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
