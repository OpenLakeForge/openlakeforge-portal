import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { extensionOf, formatSize, formatTime } from "../lib/files-api";
import type { Item } from "./FilesDialogs";
import { Icon } from "./FilesIcons";

export type RowAction = "download" | "rename" | "copy" | "delete";
export type Sort = "asc" | "desc";

type MenuState = { key: string; x: number; y: number; top: number } | null;

/** The row ⋯ menu: fixed-position so the card's clipping cannot cut it off. */
function RowMenu({ item, at, allowed, onPick, onClose }: {
  item: Item; at: { x: number; y: number; top: number }; allowed: Record<RowAction, boolean>; onPick(a: RowAction): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const entries: [RowAction, string, Parameters<typeof Icon>[0]["name"]][] = [
    ["download", "Download", "download"], ["rename", "Rename", "pencil"], ["copy", "Copy S3 URI", "copy"], ["delete", "Delete", "trash"],
  ];
  const shown = entries.filter(([a]) => allowed[a] && !(a === "download" && item.folder));
  useLayoutEffect(() => {
    const el = ref.current!;
    // Not enough room below the trigger: open above it, and never past the top of the viewport.
    if (at.y + el.offsetHeight > window.innerHeight - 8) el.style.top = `${Math.max(8, at.top - el.offsetHeight - 4)}px`;
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const away = (e: Event) => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest?.(".f-more")) onClose(); };
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  function onKeyDown(e: KeyboardEvent) {
    const els = [...ref.current!.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  }
  return (
    <div ref={ref} className="f-menu" role="menu" aria-label={`Actions for ${item.key}`} style={{ top: at.y, left: at.x }} onKeyDown={onKeyDown}>
      {shown.map(([a, label, icon]) => (
        <button key={a} type="button" role="menuitem" className={a === "delete" ? "f-danger-text" : undefined} onClick={() => onPick(a)}>
          <Icon name={icon} size={14} />{label}
        </button>
      ))}
    </div>
  );
}

export function FilesTable({ base, items, selected, onSelect, onToggleAll, sort, onSort, linkTo, allowed, onAction }: {
  base: string; items: Item[]; selected: Set<string>; onSelect(key: string, on: boolean): void; onToggleAll(on: boolean): void;
  sort: Sort; onSort(): void; linkTo(prefix: string): string; allowed: Record<RowAction, boolean>;
  onAction(a: RowAction, keys: string[]): void;
}) {
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<MenuState>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const all = items.length > 0 && items.every((i) => selected.has(i.key));
  const some = items.some((i) => selected.has(i.key));
  const header = useRef<HTMLInputElement>(null);
  useEffect(() => { if (header.current) header.current.indeterminate = some && !all; }, [some, all]);
  const cur = items[Math.min(active, items.length - 1)];
  const rowId = (key: string) => `f-row-${items.findIndex((i) => i.key === key)}`;

  // Keys act on the selection, or on the active row when nothing is selected.
  const targets = () => (some ? items.filter((i) => selected.has(i.key)) : cur ? [cur] : []).map((i) => i.key);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || !items.length) return;
    const move = (n: number) => { e.preventDefault(); setActive(Math.max(0, Math.min(items.length - 1, n))); };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === " ") { e.preventDefault(); onSelect(cur.key, !selected.has(cur.key)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (cur.folder) wrap.current?.querySelector<HTMLAnchorElement>(`#${rowId(cur.key)} a`)?.click();
      else if (allowed.download) onAction("download", [cur.key]);
    } else if (e.key === "Delete" && allowed.delete) { e.preventDefault(); onAction("delete", targets()); }
    else if (e.key === "F2" && allowed.rename) { e.preventDefault(); onAction("rename", targets()); }
  }

  function openMenu(item: Item, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const width = 176;
    setMenu({ key: item.key, x: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)), y: r.bottom + 4, top: r.top });
  }
  const menuItem = menu && items.find((i) => i.key === menu.key);

  return (
    <div ref={wrap} className="f-scroll" role="region" aria-label="Object list" tabIndex={0} onKeyDown={onKeyDown}
      aria-activedescendant={cur ? rowId(cur.key) : undefined}>
      <table className="f-table">
        <thead>
          <tr>
            <th scope="col" className="f-check">
              <input ref={header} type="checkbox" aria-label="Select all" checked={all} onChange={(e) => onToggleAll(e.target.checked)} />
            </th>
            <th scope="col" aria-sort={sort === "asc" ? "ascending" : "descending"}>
              <button type="button" className="f-sort" onClick={onSort}>Name <Icon name={sort === "asc" ? "arrowUp" : "arrowDown"} size={12} /></button>
            </th>
            <th scope="col" className="f-type">Type</th>
            <th scope="col" className="f-num">Size</th>
            <th scope="col" className="f-when">Last modified</th>
            <th scope="col" className="f-more"><span className="f-sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, n) => {
            const name = item.key.slice(base.length);
            const on = selected.has(item.key);
            return (
              <tr key={item.key} id={`f-row-${n}`} className={`${on ? "f-selected" : ""}${cur?.key === item.key ? " f-active" : ""}`}
                onClick={(e) => {
                  setActive(n);
                  if (!item.folder && !(e.target as HTMLElement).closest("button, input, a")) onSelect(item.key, !on);
                }}>
                <td className="f-check">
                  <input type="checkbox" aria-label={`Select ${name}`} checked={on} onChange={(e) => onSelect(item.key, e.target.checked)} />
                </td>
                <td className="f-name">
                  <span className={item.folder ? "f-folder-ico" : "f-file-ico"}><Icon name={item.folder ? "folder" : "file"} size={18} /></span>
                  {item.folder
                    ? <Link to={linkTo(item.key)} className="f-folder-link">{name}</Link>
                    : <span className="f-mono">{name}</span>}
                </td>
                <td className="f-type f-mono">{item.folder ? "Folder" : extensionOf(name) || "file"}</td>
                <td className="f-num f-mono">{item.folder ? "—" : formatSize(item.size ?? 0)}</td>
                <td className="f-when f-mono" title={item.modified}>{item.folder ? "—" : formatTime(item.modified)}</td>
                <td className="f-more">
                  <button type="button" className="f-icon-btn f-plain" aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={menu?.key === item.key}
                    onClick={(e) => { setActive(n); menu?.key === item.key ? setMenu(null) : openMenu(item, e.currentTarget); }}>
                    <Icon name="ellipsis" size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {menu && menuItem && (
        <RowMenu item={menuItem} at={menu} allowed={allowed} onClose={() => setMenu(null)}
          onPick={(a) => { setMenu(null); onAction(a, [menuItem.key]); }} />
      )}
    </div>
  );
}
