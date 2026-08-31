import { useEffect } from "react";
import { type HotkeyCallback, type Options, useHotkeys } from "react-hotkeys-hook";
import { isMouseKeybind, matchesMouseKeybind, mouseButtonToken } from "@/utils/keybind";

const IGNORE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

type KeybindHandler = (event?: KeyboardEvent | MouseEvent) => void;

/**
 * Drop-in replacement for `react-hotkeys-hook`'s `useHotkeys` that additionally
 * supports mouse-button bindings (`mouse3`/`mouse4`/`mouse5`, optionally with
 * modifiers). Keyboard bindings are delegated untouched; the extra `mouseN`
 * tokens are inert for the keyboard listener, so there is no double firing.
 */
export function useKeybind(keys: string, handler: KeybindHandler, options?: Options) {
    useHotkeys(keys, handler as HotkeyCallback, options);

    const enabled = options?.enabled !== false;
    const mouse = isMouseKeybind(keys);

    useEffect(() => {
        if (!mouse || !enabled) return;

        const shouldIgnore = (target: EventTarget | null) =>
            target instanceof HTMLElement &&
            (target.isContentEditable || IGNORE_TAGS.has(target.tagName));

        const onMouseDown = (event: MouseEvent) => {
            if (!mouseButtonToken(event.button)) return;
            if (shouldIgnore(event.target)) return;
            if (!matchesMouseKeybind(keys, event)) return;
            event.preventDefault();
            handler(event);
        };

        // Stop the browser acting on the same button (back/forward navigation,
        // middle-click autoscroll / open-in-new-tab).
        const onAuxClick = (event: MouseEvent) => {
            if (mouseButtonToken(event.button) && matchesMouseKeybind(keys, event)) {
                event.preventDefault();
            }
        };

        window.addEventListener("mousedown", onMouseDown, { capture: true });
        window.addEventListener("auxclick", onAuxClick, { capture: true });
        return () => {
            window.removeEventListener("mousedown", onMouseDown, { capture: true });
            window.removeEventListener("auxclick", onAuxClick, { capture: true });
        };
    }, [keys, mouse, enabled, handler]);
}
