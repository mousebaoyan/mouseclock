import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

Object.assign(process.env, loadEnv("test", import.meta.dirname, ""));

export default defineConfig({
  test: {
    globalSetup: "test/global-setup.ts",
    setupFiles: "test/setup.ts",
  },
});
