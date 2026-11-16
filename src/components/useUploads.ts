import { useCallback, useEffect, useRef, useState } from "react";
import { formatSize, messageOf, uploadObject } from "../lib/files-api";

export type UploadTarget = { stage: string; bucket: string; prefix: string };
export type UploadItem = {
  id: number; name: string; size: number; target: UploadTarget;
  status: "queued" | "uploading" | "done" | "error"; progress: number; error?: string;
};

/**
 * A sequential upload queue that outlives the dialog showing it (the dialog's Hide keeps uploads running).
 * `onUploaded` runs after each file lands, so the caller can refresh the listing it belongs to.
 */
export function useUploads(maxBytes: number, onUploaded: (target: UploadTarget) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<number, File>());
  const queue = useRef<UploadItem[]>([]); // mirrors `items`, readable synchronously by the pump
  const pumping = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const done = useRef(onUploaded);
  done.current = onUploaded;

  const patch = useCallback((id: number, change: Partial<UploadItem>) => {
    queue.current = queue.current.map((i) => (i.id === id ? { ...i, ...change } : i));
    setItems(queue.current);
  }, []);

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (let item = queue.current.find((i) => i.status === "queued"); item; item = queue.current.find((i) => i.status === "queued")) {
        const ctl = new AbortController();
        abort.current = ctl;
        patch(item.id, { status: "uploading", progress: 0 });
        try {
          await uploadObject({
            ...item.target, key: item.target.prefix + item.name, file: files.current.get(item.id)!, signal: ctl.signal,
            onProgress: (f) => patch(item.id, { progress: f }),
          });
          patch(item.id, { status: "done", progress: 1 });
          done.current(item.target);
        } catch (e) {
          const cancelled = e instanceof DOMException && e.name === "AbortError";
          patch(item.id, { status: "error", error: cancelled ? "Cancelled" : messageOf(e) });
        }
        files.current.delete(item.id);
      }
    } finally {
      abort.current = null;
      pumping.current = false;
    }
  }, [patch]);

  const add = useCallback((picked: File[], target: UploadTarget) => {
    const added = picked.map((f): UploadItem => {
      const tooLarge = maxBytes > 0 && f.size > maxBytes;
      const item: UploadItem = {
        id: nextId.current++, name: f.name, size: f.size, target, progress: 0,
        status: tooLarge ? "error" : "queued",
        error: tooLarge ? `Too large: the limit is ${formatSize(maxBytes)}.` : undefined,
      };
      if (!tooLarge) files.current.set(item.id, f);
      return item;
    });
    queue.current = [...queue.current, ...added];
    setItems(queue.current);
    void pump();
  }, [maxBytes, pump]);

  /** Stops the running upload and drops the queued ones. */
  const cancel = useCallback(() => {
    for (const i of queue.current) if (i.status === "queued") files.current.delete(i.id);
    queue.current = queue.current.filter((i) => i.status !== "queued");
    setItems(queue.current);
    abort.current?.abort();
  }, []);

  const clear = useCallback(() => {
    queue.current = queue.current.filter((i) => i.status === "queued" || i.status === "uploading");
    setItems(queue.current);
  }, []);

  // Leaving the page drops what is queued first, so aborting the running upload cannot start the next one.
  useEffect(() => () => {
    queue.current = queue.current.filter((i) => i.status !== "queued");
    files.current.clear();
    abort.current?.abort();
  }, []);

  const active = items.some((i) => i.status === "queued" || i.status === "uploading");
  return { items, active, add, cancel, clear };
}
