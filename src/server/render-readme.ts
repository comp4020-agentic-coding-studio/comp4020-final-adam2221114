import { readFileSync } from "node:fs";
import path from "node:path";

// Reproduces, in Node instead of shell, exactly what the template Dockerfile
// did with `sed`: escape README.md as plain text and drop it into the
// `@README@` marker in the template. Same order (&, then <, then >) so the
// escaping behaves identically to what already passed spec/invariants.test.ts.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderReadme(cwd: string = process.cwd()): string {
  const readme = readFileSync(path.join(cwd, "README.md"), "utf8");
  const template = readFileSync(path.join(cwd, "assets", "readme-template.html"), "utf8");
  return template.replace("@README@", escapeHtml(readme));
}
