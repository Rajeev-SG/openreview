import { mock } from "bun:test";

/**
 * `server-only` throws when imported outside a React server component, which
 * makes server modules untestable from `bun test`. The adapter-level tests need
 * the real `lib/frontier/octokit.ts`, so the marker module is stubbed here.
 *
 * Only the guard is stubbed; no behaviour of the module under test changes.
 */
mock.module("server-only", () => ({}));
