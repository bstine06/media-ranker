import { useEffect } from "react";

interface UseKeyboardShortcutArgs {
  key: string;
  onKeyPressed: () => void;
  enabled?: boolean;
}

export function useKeyboardShortcut({
  key,
  onKeyPressed,
  enabled = true,
}: UseKeyboardShortcutArgs) {
  useEffect(() => {
    if (!enabled) return;
    function keyDownHandler(e: globalThis.KeyboardEvent) {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) return;

      if (e.key === key) {
        e.preventDefault();
        onKeyPressed();
      }
    }

    document.addEventListener("keydown", keyDownHandler);
    return () => document.removeEventListener("keydown", keyDownHandler);
  }, [key, onKeyPressed, enabled]);
}