// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTime, setZoneChoice, ZONE_KEY } from "../lib/time";
import { Ago, Time, Zoned, ZoneSwitch } from "./Time";

const NY = "America/New_York";
const AT = "2026-11-19T17:28:05Z";
const NOW = Date.UTC(2026, 10, 20, 12, 0);

/** The browser's zone, as Intl reports it. */
const browserIn = (zone: string) =>
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: zone } as Intl.ResolvedDateTimeFormatOptions);

function Page() {
  return (
    <>
      <ZoneSwitch />
      <table><thead><tr><th><Zoned>Started</Zoned></th></tr></thead><tbody><tr><td data-testid="cell"><Time at={AT} now={NOW} bare /></td></tr></tbody></table>
      <p data-testid="line">started <Time at={AT} now={NOW} /></p>
      <p data-testid="ago">Checked <Ago at={AT} now={NOW} /></p>
    </>
  );
}

afterEach(() => { vi.restoreAllMocks(); setZoneChoice("utc"); });

describe("one labelled time zone", () => {
  it("opens in UTC: a column header names the zone, a time on its own carries it, a relative time keeps the absolute one", () => {
    browserIn(NY);
    render(<Page />);
    expect(screen.getByRole("radio", { name: "UTC" })).toBeChecked();
    expect(screen.getByRole("radio", { name: `Local (${NY})` })).not.toBeChecked();
    expect(screen.getByRole("columnheader")).toHaveTextContent("Started (UTC)");
    expect(screen.getByTestId("cell")).toHaveTextContent(/^Nov 19 17:28$/);
    expect(screen.getByTestId("line")).toHaveTextContent(/^started Nov 19 17:28 UTC$/);
    const time = screen.getByTestId("line").querySelector("time")!;
    expect(time).toHaveAttribute("dateTime", "2026-11-19T17:28:05.000Z");
    expect(time).toHaveAttribute("title", "Nov 19, 2026 17:28:05 UTC");
    // "18 h ago" on hover is the absolute time, and a screen reader hears it too: not hover-only.
    const ago = screen.getByTestId("ago").querySelector("time")!;
    expect(ago).toHaveAttribute("title", "Nov 19, 2026 17:28:05 UTC");
    expect(ago).toHaveAttribute("dateTime", "2026-11-19T17:28:05.000Z");
    expect(screen.getByTestId("ago")).toHaveTextContent(/^Checked 18 h ago \(at Nov 19 17:28 UTC\)$/);
  });

  it("switches every time on the page to the browser's zone, and keeps the choice in this browser", async () => {
    browserIn(NY);
    const { unmount } = render(<Page />);
    await userEvent.click(screen.getByRole("radio", { name: `Local (${NY})` }));
    expect(window.localStorage.getItem(ZONE_KEY)).toBe("local");
    expect(screen.getByRole("columnheader")).toHaveTextContent(`Started (${NY})`);
    expect(screen.getByTestId("cell")).toHaveTextContent(/^Nov 19 12:28$/);
    expect(screen.getByTestId("line")).toHaveTextContent(`started Nov 19 12:28 ${NY}`);
    expect(screen.getByTestId("line").querySelector("time")).toHaveAttribute("title", `Nov 19, 2026 12:28:05 ${NY}`);
    expect(screen.getByTestId("ago")).toHaveTextContent(`(at Nov 19 12:28 ${NY})`);
    // Another page of the browser reads the same choice.
    unmount();
    render(<Page />);
    expect(screen.getByRole("radio", { name: `Local (${NY})` })).toBeChecked();
    expect(screen.getByTestId("cell")).toHaveTextContent("Nov 19 12:28");
    await userEvent.click(screen.getByRole("radio", { name: "UTC" }));
    expect(window.localStorage.getItem(ZONE_KEY)).toBe("utc");
    expect(screen.getByTestId("cell")).toHaveTextContent("Nov 19 17:28");
  });

  it("opens in UTC when storage cannot be read, and the switch still works for the page", async () => {
    browserIn(NY);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    render(<Page />);
    expect(screen.getByRole("radio", { name: "UTC" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: `Local (${NY})` }));
    expect(screen.getByTestId("cell")).toHaveTextContent("Nov 19 12:28");
  });

  it("renders UTC on the server and switches after hydration, with no hydration mismatch", async () => {
    browserIn(NY);
    window.localStorage.setItem(ZONE_KEY, "local");
    // The server cannot know the browser's choice or zone: it writes UTC, and "Local" without a zone.
    const html = renderToString(<Page />);
    expect(html).toContain("Started<!-- --> (<!-- -->UTC<!-- -->)");
    expect(html).toContain(">Local<");
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable: unknown[] = [];
    await act(async () => { hydrateRoot(host, <Page />, { onRecoverableError: (e) => recoverable.push(e) }); });
    expect(errors).not.toHaveBeenCalled();
    expect(recoverable).toEqual([]);
    expect(host.querySelector("th")).toHaveTextContent(`Started (${NY})`);
    expect(host.querySelector("[data-testid=cell]")).toHaveTextContent(formatTime(AT, NY, NOW));
    expect(host.querySelector<HTMLInputElement>("input[value=local]")!.checked).toBe(true);
    host.remove();
  });
});
