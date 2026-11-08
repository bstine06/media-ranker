// Shared bits of the viewers' keyboard scheme. Every viewer (Compare,
// Browse scroll, single file) uses the same keys:
//   Space / ↓  confirm (Compare: focused side wins) or next file
//   W / ↑      previous (Compare: undo the last pick)
//   Q / ←      rewind          E / →  fast forward
//   V          play / pause    R      rotate left    K  king (crown / Compare)
//   Tab        Compare: switch side

/** True while the user is typing somewhere keys should be left alone. A
 *  dropdown doesn't count: once picked from, keys go back to the viewer. */
export function isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return (
        (el instanceof HTMLInputElement &&
            !["checkbox", "radio", "range", "button", "submit"].includes(el.type)) ||
        el?.tagName === "TEXTAREA" ||
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
        if (e.code === "Space" || e.code === "Tab") {
            e.preventDefault();
            // A focused dropdown would open on Space: let go of it.
            const el = document.activeElement;
            if (el instanceof HTMLSelectElement) el.blur();
        }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
    };
}
