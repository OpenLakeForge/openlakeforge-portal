import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// No vitest globals, so Testing Library does not unmount between tests by itself.
afterEach(cleanup);
// What a page keeps in the browser (the Monitoring time zone, portal#40) starts afresh for each test.
afterEach(() => { if (typeof window !== "undefined") { try { window.localStorage.clear(); } catch { /* no storage */ } } });
