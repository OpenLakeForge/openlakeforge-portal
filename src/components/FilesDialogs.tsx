import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { baseName, formatSize, messageOf, nameProblem, type FileObject } from "../lib/files-api";
import { Icon } from "./FilesIcons";
import type { UploadItem } from "./useUploads";

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** A modal dialog: focus moves in, Tab stays inside, Esc closes, and focus returns to where it came from. */
export function Modal({ title, hint, onClose, children, wide }: {
  title: string; hint?: string; onClose(): void; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const box = ref.current!;
    (box.querySelector<HTMLElement>("[data-autofocus]") ?? box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();
    return () => back?.focus?.();
  }, []);
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
    if (e.key !== "Tab") return;
    const els = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!els.length) return e.preventDefault();
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  return (
    <div className="f-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`f-dialog${wide ? " f-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="f-dialog-head">
          <h2 id={titleId}>{title}</h2>
          {hint && <span className="f-hint">{hint}</span>}
          <button type="button" className="f-icon-btn f-close" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** One text field and a confirm button, shared by New folder and Rename. */
function NameDialog({ title, hint, label, initial, suffix, submit, action, onClose, changed }: {
  title: string; hint?: string; label: string; initial: string; suffix?: string; action: string;
  submit(name: string): Promise<void>; onClose(): void; changed?: boolean;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current!;
    // Rename selects the name, not its extension, so typing replaces the part people change.
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, []);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = nameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError(undefined);
    try {
      await submit(name.trim());
      onClose();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }
  const unchanged = changed && name.trim() === initial;
  return (
    <Modal title={title} hint={hint} onClose={onClose}>
      <form onSubmit={onSubmit} noValidate>
        <div className="f-field">
          <input ref={input} data-autofocus type="text" aria-label={label} value={name} autoComplete="off" spellCheck={false}
            aria-invalid={!!error} aria-describedby={error ? "f-name-error" : undefined}
            onChange={(e) => { setName(e.target.value); setError(undefined); }} />
          {suffix && <span className="f-suffix" aria-hidden="true">{suffix}</span>}
        </div>
        {error && <p id="f-name-error" className="f-error" role="alert">{error}</p>}
        <div className="f-dialog-actions">
          <button type="button" className="f-btn f-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-primary" disabled={busy || unchanged}>{action}</button>
        </div>
      </form>
    </Modal>
  );
}

export const NewFolderDialog = ({ prefix, create, onClose }: { prefix: string; create(name: string): Promise<void>; onClose(): void }) => (
  <NameDialog title="New folder" hint={prefix || undefined} label="Folder name" initial="" suffix="/" action="Create" submit={create} onClose={onClose} />
);

export const RenameDialog = ({ item, rename, onClose }: { item: Item; rename(name: string): Promise<void>; onClose(): void }) => (
  <NameDialog title="Rename" label="New name" initial={baseName(item.key)} action="Rename" changed submit={rename} onClose={onClose} />
);

/** A row of the listing: a folder (key ends in "/") or a file. */
export type Item = { key: string; folder: boolean; size?: number; modified?: string };
export const itemOf = (f: FileObject): Item => ({ key: f.key, folder: false, size: f.size, modified: f.last_modified });

export function DeleteDialog({ items, base, remove, onClose }: {
  items: Item[]; base: string; remove(): Promise<{ key: string; detail: string }[]>; onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [failed, setFailed] = useState<{ key: string; detail: string }[]>([]);
  async function go() {
    setBusy(true);
    setError(undefined);
    try {
      const errors = await remove();
      if (!errors.length) return onClose();
      setFailed(errors);
    } catch (e) {
      setError(messageOf(e));
    }
    setBusy(false);
  }
  return (
    <Modal title={`Delete ${items.length} ${items.length === 1 ? "item" : "items"}?`} onClose={onClose}>
      <ul className="f-delete-list">
        {items.map((i) => (
          <li key={i.key}>
            <span className={i.folder ? "f-folder-ico" : "f-file-ico"}><Icon name={i.folder ? "folder" : "file"} size={14} /></span>
            <span className="f-mono f-grow">{i.key.slice(base.length)}</span>
            <span className="f-meta">{i.folder ? "all contents" : formatSize(i.size ?? 0)}</span>
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <ul className="f-error f-failed" role="alert">
          {failed.map((f) => <li key={f.key}><span className="f-mono">{f.key.slice(base.length)}</span>: {f.detail}</li>)}
        </ul>
      )}
      {error && <p className="f-error" role="alert">{error}</p>}
      <p className="f-error">This can’t be undone.</p>
      <div className="f-dialog-actions">
        <button type="button" className="f-btn f-ghost" onClick={onClose}>Cancel</button>
        <button type="button" data-autofocus className="f-btn f-danger" disabled={busy} onClick={go}>Delete</button>
      </div>
    </Modal>
  );
}

export function UploadDialog({ prefix, items, add, cancel, onHide }: {
  prefix: string; items: UploadItem[]; add(files: File[]): void; cancel(): void; onHide(): void;
}) {
  const pick = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const running = items.some((i) => i.status === "queued" || i.status === "uploading");
  return (
    <Modal title="Upload" hint={prefix || undefined} onClose={onHide} wide>
      <div className={`f-drop${over ? " f-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add([...e.dataTransfer.files]); }}>
        <Icon name="upload" size={20} />
        <span>Drop files or <button type="button" className="f-link" data-autofocus onClick={() => pick.current?.click()}>browse</button></span>
        <input ref={pick} type="file" multiple hidden aria-label="Choose files"
          onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      <ul className="f-uploads" aria-label="Uploads">
        {items.map((i) => (
          <li key={i.id}>
            <div className="f-up-row">
              <span className="f-file-ico"><Icon name="file" size={14} /></span>
              <span className="f-mono">{i.name}</span>
              <span className="f-meta">{formatSize(i.size)}</span>
              <span className={`f-up-state f-${i.status}`} role={i.status === "error" ? "alert" : undefined}>
                {i.status === "done" ? "Done" : i.status === "error" ? i.error
                  : i.status === "queued" ? "Queued" : `${Math.round(i.progress * 100)}%`}
              </span>
            </div>
            <div className={`f-bar f-${i.status}`} role="progressbar" aria-label={`Upload ${i.name}`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(i.progress * 100)}>
              <span style={{ width: `${(i.status === "done" ? 1 : i.status === "error" ? 0 : i.progress) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <div className="f-dialog-actions">
        <button type="button" className="f-btn f-ghost" onClick={() => { if (running) cancel(); else onHide(); }}>Cancel</button>
        <button type="button" className="f-btn f-outline" onClick={onHide}>Hide</button>
      </div>
    </Modal>
  );
}

