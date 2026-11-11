"use strict";
// Cross-platform replacement for `mkdir -p dist/wasm && cp src/wasm/*.{js,wasm,d.ts} dist/wasm/`.
// The previous shell version relied on `cp`/`mkdir -p`, which are not available
// on a plain Windows `cmd.exe`/PowerShell shell (no WSL/Git Bash), so `npm run build`
// — and therefore `npm publish` via `prepublishOnly` — could fail or silently
// produce an incomplete `dist/` on Windows. This script works identically on
// Windows, macOS, and Linux using only Node's built-in `fs` module.
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src", "wasm");
const DEST_DIR = path.join(__dirname, "..", "dist", "wasm");
const EXTENSIONS = [".js", ".wasm", ".d.ts"];

fs.mkdirSync(DEST_DIR, { recursive: true });

const entries = fs.readdirSync(SRC_DIR);
let copied = 0;
for (const name of entries) {
  if (!EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
  fs.copyFileSync(path.join(SRC_DIR, name), path.join(DEST_DIR, name));
  copied += 1;
}

if (copied === 0) {
  console.error(`No WASM bindings found in ${SRC_DIR} — did you run "npm run build:wasm"?`);
  process.exit(1);
}

console.log(`Copied ${copied} WASM binding file(s) to ${DEST_DIR}`);
