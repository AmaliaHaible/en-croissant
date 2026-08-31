/**
 * Mouse buttons that may be used as keybinds, keyed by `MouseEvent.button`.
 * Left (0) and right (2) are intentionally excluded so board interaction keeps working.
 * MB3 = wheel click, MB4 = back / thumb, MB5 = forward / thumb.
 */
const MOUSE_BUTTON_TOKENS: Record<number, string> = {
    1: "mouse3",
    3: "mouse4",
    4: "mouse5",
};

const MOUSE_TOKENS = new Set(Object.values(MOUSE_BUTTON_TOKENS));

export type MouseModifiers = Pick<
    MouseEvent,
    "button" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

/** Token for a physical mouse button, or `null` when that button is not bindable. */
export function mouseButtonToken(button: number): string | null {
    return MOUSE_BUTTON_TOKENS[button] ?? null;
}

/** Whether `keys` (a possibly comma-separated keybind string) contains a mouse-button combo. */
export function isMouseKeybind(keys: string): boolean {
    return splitCombos(keys).some((parts) => parts.some((part) => MOUSE_TOKENS.has(part)));
}

/**
 * Build a keybind string from a mouse event, e.g. `"ctrl+shift+mouse4"`.
 * Returns `null` for non-bindable buttons (left/right/unknown).
 */
export function mouseEventToKeybind(event: MouseModifiers): string | null {
    const token = mouseButtonToken(event.button);
    if (!token) return null;
    const parts: string[] = [];
    if (event.ctrlKey) parts.push("ctrl");
    if (event.shiftKey) parts.push("shift");
    if (event.altKey) parts.push("alt");
    if (event.metaKey) parts.push("meta");
    parts.push(token);
    return parts.join("+");
}

/** Whether a mouse event matches one of the mouse-button combos in `keys`. */
export function matchesMouseKeybind(keys: string, event: MouseModifiers): boolean {
    const token = mouseButtonToken(event.button);
    if (!token) return false;
    return splitCombos(keys).some((parts) => {
        if (!parts.includes(token)) return false;
        if (parts.includes("mod")) {
            if (!event.ctrlKey && !event.metaKey) return false;
        } else {
            if (event.ctrlKey !== parts.includes("ctrl")) return false;
            if (event.metaKey !== parts.includes("meta")) return false;
        }
        if (event.shiftKey !== parts.includes("shift")) return false;
        if (event.altKey !== parts.includes("alt")) return false;
        return true;
    });
}

function splitCombos(keys: string): string[][] {
    return keys
        .toLowerCase()
        .split(",")
        .map((combo) =>
            combo
                .split("+")
                .map((part) => part.trim())
                .filter(Boolean),
        )
        .filter((parts) => parts.length > 0);
}
