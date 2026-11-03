import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The CLI and MCP tests run the built files in dist/, as a user would, so build once before any test file starts
   (doing it inside each file would let parallel files delete each other's output). */
export default function setup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execSync("npx tsup", { cwd: root, stdio: "pipe" });
}
