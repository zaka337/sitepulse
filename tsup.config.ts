import { defineConfig } from "tsup";

// Three entry points: the library, the command line tool and the MCP server. The two executables carry their own
// "#!/usr/bin/env node" line (from the source); dependencies stay external and are installed by npm.
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts", mcp: "src/mcp.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  splitting: true,
});
