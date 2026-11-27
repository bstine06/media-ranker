// Shared bits of the viewers' keyboard scheme. Every viewer (Compare,
// Browse scroll, single file) uses the same keys:
//   2 / ↓      Compare: confirm (focused side wins)
//   W / ↑      Compare: undo the last pick
//   1 / 3      Compare: focus the left / right side; the file view (Browse)
//              and a pass: previous / next file
//   Q / ←      step back       E / →  step forward   (the focused video)
//   P          play / pause    hold 4 fast-forward   (lib/fastForward)
//   R          rotate left     K      king (crown / Compare)
// Space, Tab / Shift+Tab, T, ` and H belong to the tag pointer everywhere
// it is (contexts/TagPointerContext). Compare has no pointer: there Space
// picks the focused side (like 2) and Tab does nothing.

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
