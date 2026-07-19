// GitView docs — shared behaviour: mermaid diagrams (theme-aware), active nav link, mobile nav toggle.
// Hand-authored; no build step. Mermaid is loaded from a CDN at view time.

import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({
  startOnLoad: true,
  theme: dark ? "dark" : "neutral",
  themeVariables: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "14px" },
  flowchart: { curve: "basis", htmlLabels: true },
  sequence: { useMaxWidth: true },
});

// Highlight the current page in the sidebar.
const here = location.pathname.split("/").pop() || "index.html";
document.querySelectorAll(".sidebar nav a").forEach((a) => {
  const href = a.getAttribute("href");
  if (href === here || (here === "" && href === "index.html")) a.setAttribute("aria-current", "page");
});

// Mobile navigation toggle.
const toggle = document.getElementById("navToggle");
if (toggle) {
  toggle.addEventListener("click", () => document.body.classList.toggle("nav-open"));
  document.querySelectorAll(".sidebar nav a").forEach((a) =>
    a.addEventListener("click", () => document.body.classList.remove("nav-open")),
  );
}
