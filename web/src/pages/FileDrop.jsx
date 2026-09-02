import React, { useEffect, useRef, useState } from "react";

// Drop files straight onto the app instead of saving them out and uploading.
//
// Handles three ways of getting a file in:
//   - dragged from Explorer/Finder (and from classic Outlook on Windows)
//   - pasted with Ctrl+V, which covers screenshots and copied attachments
//   - the ordinary file picker, still there underneath
//
// Note for expectations: the new Outlook and Outlook on the web hand over a
// reference rather than the file itself, and no browser can read that. Copying
// the attachment and pasting works in those cases.

export default function FileDrop({ onFiles, disabled, accept, paste = false, children, label }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);          // dragenter/leave fire per child element

  const take = (list) => {
    const files = Array.from(list ?? []).filter((f) => f && f.size > 0);
    if (!files.length) return;
    if (accept === "image") {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      if (!imgs.length) return;
      onFiles(imgs);
      return;
    }
    onFiles(files);
  };

  useEffect(() => {
    if (!paste || disabled) return;
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      take(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [paste, disabled, onFiles]);

  if (disabled) return children;

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        take(e.dataTransfer?.files);
      }}
      style={{
        position: "relative",
        outline: over ? "2px dashed var(--accent)" : "none",
        outlineOffset: 4,
        borderRadius: 12,
      }}
    >
      {children}
      {over && (
        <div style={{
          position: "absolute", inset: 0, background: "rgba(240,74,0,.06)",
          display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: 12, pointerEvents: "none", fontWeight: 600,
          color: "var(--accent)", fontSize: 14,
        }}>
          {label ?? "Drop to upload"}
        </div>
      )}
    </div>
  );
}
