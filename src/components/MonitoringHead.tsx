import type { Instant } from "../lib/time";
import { Icon } from "./FilesIcons";
import { Ago, ZoneSwitch } from "./Time";

/** The head of the Monitoring views: the title, and on one line at its end the zone switch and the page's own controls. */
export function MonitoringHead({ children }: { children?: React.ReactNode }) {
  return (
    <div className="q-head mon-head">
      <h1>Monitoring</h1>
      <div className="mon-head-end">
        <ZoneSwitch />
        {children}
      </div>
    </div>
  );
}

/** "Updated 5 s ago" and the Refresh button, both as high as the zone switch. */
export function Fresh({ at, now, onRefresh, title }: { at: Instant; now: number; onRefresh(): void; title?: string }) {
  return (
    <>
      <p className="mon-fresh" role="status" title={title}>Updated <Ago at={at} now={now} /></p>
      <button type="button" className="f-btn f-outline mon-refresh" onClick={onRefresh}><Icon name="refresh" size={14} /> Refresh</button>
    </>
  );
}
