import { Platform } from "react-native";

import { colors } from "./theme";

// The browser draws its own black focus outline. These rules use the accent colour instead.
// The !important beats the single-class rules of react-native-web.
const CSS = `
input:focus, textarea:focus {
  outline: none !important;
  box-shadow: 0 0 0 2px ${colors.light.accent}59;
}
[role="button"]:focus-visible, [role="tab"]:focus-visible, [role="radio"]:focus-visible,
[role="switch"]:focus-visible, button:focus-visible {
  outline: 2px solid ${colors.light.accent} !important;
  /* Inside the element: list rows fill their parent, which clips a ring drawn outside. */
  outline-offset: -2px;
}
`;

let installed = false;

/** Adds the web focus styles to the document once. Does nothing on native. */
export function installWebStyles(): void {
  if (installed || Platform.OS !== "web" || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.setAttribute("data-money-tracker", "focus");
  style.textContent = CSS;
  document.head.appendChild(style);
}
