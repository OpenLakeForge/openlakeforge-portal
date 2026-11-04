import { useEffect, useRef } from "react";

type Props = { value: string; onChange(text: string): void; onRun(): void };

/** The CodeMirror editor, mounted in the browser after hydration. */
export function SqlEditor({ value, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<{ set(text: string): void; destroy(): void }>(undefined);
  const latest = useRef({ value, onChange, onRun });
  latest.current = { value, onChange, onRun };

  useEffect(() => {
    let dead = false;
    import("./cm-editor").then(({ mountEditor }) => {
      if (dead || !host.current) return;
      handle.current = mountEditor(host.current, {
        doc: latest.current.value,
        onChange: (t) => latest.current.onChange(t),
        onRun: () => latest.current.onRun(),
      });
    });
    return () => {
      dead = true;
      handle.current?.destroy();
      handle.current = undefined;
    };
  }, []);

  useEffect(() => handle.current?.set(value), [value]);

  return <div className="q-code" ref={host} />;
}
