// Shared bits of the viewers' keyboard scheme. Every viewer (Compare,
// Discover, Browse scroll, single file) uses the same keys:
//   Space / ↓  confirm (Compare: focused side wins) or next file
//   W / ↑      previous (Compare: undo the last pick)
//   Q / ←      rewind          E / →  fast forward
//   V          play / pause    R      crown (send to Compare)
//   Tab        Compare: switch side
//   1–4, `, T  quick tags (QuickTagBar)

/** True while the user is typing somewhere keys should be left alone. */
export function isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return (
        (el instanceof HTMLInputElement &&
            !["checkbox", "radio", "range", "button", "submit"].includes(el.type)) ||
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "SELECT" ||
        !!el?.isContentEditable
    );
}

/**
 * Space and Tab belong to the viewer's hotkeys, not the page: without this,
 * Space re-clicks whatever button was clicked last (a quick tag chip) and
 * Tab walks focus around the page. Returns a cleanup.
 */
export function claimSpaceAndTab(): () => void {
    const onKey = (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return;
        if (e.code === "Space" || e.code === "Tab") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
    };
}
