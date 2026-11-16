// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUploads } from "./useUploads";

class FakeXhr {
  static all: FakeXhr[] = [];
  upload = {};
  onload?: () => void; onerror?: () => void; onabort?: () => void;
  constructor() { FakeXhr.all.push(this); }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() { this.onabort?.(); }
}
afterEach(() => vi.unstubAllGlobals());

it("starts no further upload once the page is gone", async () => {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  const { result, unmount } = renderHook(() => useUploads(0, () => {}));
  act(() => result.current.add(
    ["a", "b", "c"].map((n) => new File(["x"], n)), { stage: "dev", bucket: "b", prefix: "" },
  ));
  expect(FakeXhr.all).toHaveLength(1); // one at a time
  unmount();
  await new Promise((r) => setTimeout(r, 20)); // let the aborted upload settle
  expect(FakeXhr.all).toHaveLength(1);
});
