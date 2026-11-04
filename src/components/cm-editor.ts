// Loaded only in the browser (dynamic import from SqlEditor): CodeMirror never reaches the server render.
import { syntaxHighlighting } from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { keymap, placeholder } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";

export function mountEditor(parent: HTMLElement, opts: { doc: string; onChange(text: string): void; onRun(): void }) {
  const view = new EditorView({
    parent,
    doc: opts.doc,
    extensions: [
      // First, so it wins over the default keymap's Mod-Enter (insert blank line).
      keymap.of([{ key: "Mod-Enter", run: () => (opts.onRun(), true) }]),
      basicSetup,
      sql(),
      syntaxHighlighting(classHighlighter), // static tok-* classes, coloured by the tokens in queries.css
      placeholder("SELECT * FROM schema.table LIMIT 100"),
      EditorView.contentAttributes.of({ "aria-label": "SQL query" }),
      EditorView.updateListener.of((u) => u.docChanged && opts.onChange(u.state.doc.toString())),
    ],
  });
  return {
    set(text: string) {
      const cur = view.state.doc.toString();
      if (cur !== text) view.dispatch({ changes: { from: 0, to: cur.length, insert: text } });
    },
    destroy: () => view.destroy(),
  };
}
