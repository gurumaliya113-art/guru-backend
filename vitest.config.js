import { defineConfig } from "vitest/config";

export default defineConfig({
  // This backend folder lives inside the frontend checkout, so Vite would walk
  // up and load the frontend's postcss.config.js (tailwind isn't installed
  // here, which crashed the run). Backend tests never touch CSS.
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.js", "test/**/*.test.js"],
  },
});
