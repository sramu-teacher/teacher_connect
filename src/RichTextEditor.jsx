import { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Italic, List, Sparkles, Loader2 } from "lucide-react";

const POLISH_WORKER_URL = import.meta.env.VITE_POLISH_WORKER_URL;

const extensions = [
  StarterKit.configure({
    heading: false,
    codeBlock: false,
    blockquote: false,
    horizontalRule: false,
    orderedList: false,
  }),
];

function toolbarBtnStyle(active) {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    border: "none",
    borderRadius: 5,
    background: active ? "#EFE1C4" : "transparent",
    color: active ? "#7A5A18" : "#6B6455",
    cursor: "pointer",
  };
}

// Bold/italic/bulleted-list editor for free-text fields that benefit
// from light structure (e.g. behavior notes with multiple dated
// entries). Controlled like a textarea: `value` is an HTML string,
// `onChange(html)` fires on every edit. Default-lazy-loaded by the
// caller via React.lazy, since Tiptap adds real bundle weight that
// most page loads (nobody expanding a student card) shouldn't pay for.
export default function RichTextEditor({ value, onChange, placeholder }) {
  const [polishing, setPolishing] = useState(false);
  const [polishError, setPolishError] = useState(null);

  const editor = useEditor({
    extensions: [...extensions, Placeholder.configure({ placeholder: placeholder || "" })],
    content: value || "",
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });

  // Keep the editor in sync when `value` changes from outside typing
  // (e.g. a flagged Quick Observation auto-appending while this card is
  // already expanded). `false` suppresses onUpdate so this can't loop.
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || "", false);
    }
  }, [value, editor]);

  // Sends the plain text to a small backend proxy (an API key can't
  // safely live in browser code, so this can't call Claude directly) for
  // a wording pass — clearer, more objective phrasing without inventing
  // new content. Round-trips through plain text, so it flattens any
  // existing bold/italic/bullet formatting in the field being polished.
  const handlePolish = async () => {
    if (!editor || polishing) return;
    const plain = editor.getText().trim();
    if (!plain) return;
    if (!POLISH_WORKER_URL) {
      setPolishError("AI polish isn't configured for this deployment.");
      return;
    }
    setPolishing(true);
    setPolishError(null);
    try {
      const res = await fetch(POLISH_WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: plain }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      editor.commands.setContent(data.polished, false);
      onChange(editor.getHTML());
    } catch (err) {
      setPolishError(err.message || "Couldn't polish this text — please try again.");
    } finally {
      setPolishing(false);
    }
  };

  if (!editor) return null;

  return (
    <div style={{ border: "1px solid #D9D2C0", borderRadius: 7, background: "#FAF7F0", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 2, padding: "4px 6px", borderBottom: "1px solid #D9D2C0", background: "#F1ECE0" }}>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBold().run()}
          style={toolbarBtnStyle(editor.isActive("bold"))}
          aria-label="Bold"
        >
          <Bold size={13} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          style={toolbarBtnStyle(editor.isActive("italic"))}
          aria-label="Italic"
        >
          <Italic size={13} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          style={toolbarBtnStyle(editor.isActive("bulletList"))}
          aria-label="Bulleted list"
        >
          <List size={13} />
        </button>
        <button
          type="button"
          onClick={handlePolish}
          disabled={polishing}
          style={{ ...toolbarBtnStyle(false), marginLeft: "auto", opacity: polishing ? 0.6 : 1 }}
          aria-label="Polish wording with AI"
          title="Polish wording with AI"
        >
          {polishing ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
        </button>
      </div>
      <EditorContent editor={editor} className="rte-content" />
      {polishError && (
        <div className="sans" style={{ padding: "4px 10px 6px", fontSize: 11, color: "#A6452F" }}>
          {polishError}
        </div>
      )}
    </div>
  );
}
