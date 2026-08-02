import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Italic, List } from "lucide-react";

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
      </div>
      <EditorContent editor={editor} className="rte-content" />
    </div>
  );
}
