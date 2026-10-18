import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./test",
    testMatch: "**/*.spec.mjs",
    workers: 1,
    reporter: "list",
    use: { browserName: "chromium", viewport: { width: 1440, height: 1050 } },
});
