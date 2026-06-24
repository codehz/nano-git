import { defineConfig } from "tsdown";

function addTypesExport(exports: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value !== "string") {
        return [key, value];
      }
      if (key === "./package.json") {
        return [key, value];
      }

      if (value.endsWith(".mjs")) {
        return [
          key,
          {
            types: value.replace(/\.mjs$/u, ".d.mts"),
            default: value,
          },
        ];
      }

      if (value.endsWith(".ts")) {
        return [key, value];
      }

      return [key, value];
    }),
  );
}

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/sha1.ts",
    "src/errors.ts",
    "src/hash-file.ts",
    "src/objects/index.ts",
    "src/pack/index.ts",
    "src/odb/memory.ts",
    "src/odb/file.ts",
    "src/odb/sqlite.ts",
    "src/refs/memory.ts",
    "src/refs/file.ts",
    "src/refs/sqlite.ts",
    "src/refs/names.ts",
    "src/refs/resolve.ts",
    "src/refs/shallow/memory.ts",
    "src/refs/shallow/file.ts",
    "src/refs/shallow/sqlite.ts",
    "src/remote/http.ts",
    "src/log/index.ts",
    "src/backend/index.ts",
    "src/backend/memory.ts",
    "src/backend/file.ts",
    "src/backend/sqlite.ts",
    "src/repository/core.ts",
    "src/repository/memory.ts",
    "src/repository/file.ts",
    "src/repository/sqlite.ts",
    "src/repository/tree/tree-patch.ts",
    "src/repository/tree/tree-walk.ts",
    "src/transport/index.ts",
    "src/transport/upload-pack.ts",
    "src/transport/receive-pack.ts",
    "src/transport/http/index.ts",
    "src/transport/server/upload-pack/index.ts",
    "src/transport/server/receive-pack/index.ts",
    "src/workdir/memory.ts",
    "src/workdir/core.ts",
    "src/workdir/sqlite.ts",
    "src/workdir/file.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "esnext",
  platform: "node",
  shims: false,
  unbundle: true,
  exports: {
    packageJson: false,
    legacy: true,
    customExports(exports) {
      return addTypesExport(exports);
    },
  },
  deps: {
    neverBundle: ["bun:sqlite"],
  },
});
