import { expect, test } from "vitest";
import {
    isMouseKeybind,
    matchesMouseKeybind,
    mouseButtonToken,
    mouseEventToKeybind,
    type MouseModifiers,
} from "../keybind";

const evt = (button: number, mods: Partial<MouseModifiers> = {}): MouseModifiers => ({
    button,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
});

test("mouseButtonToken maps middle and side buttons, ignores left/right", () => {
    expect(mouseButtonToken(1)).toBe("mouse3");
    expect(mouseButtonToken(3)).toBe("mouse4");
    expect(mouseButtonToken(4)).toBe("mouse5");
    expect(mouseButtonToken(0)).toBeNull();
    expect(mouseButtonToken(2)).toBeNull();
});

test("isMouseKeybind detects mouse combos", () => {
    expect(isMouseKeybind("mouse4")).toBe(true);
    expect(isMouseKeybind("ctrl+mouse3")).toBe(true);
    expect(isMouseKeybind("arrowleft,mouse5")).toBe(true);
    expect(isMouseKeybind("ctrl+l")).toBe(false);
    expect(isMouseKeybind("f")).toBe(false);
});

test("mouseEventToKeybind serialises button plus held modifiers", () => {
    expect(mouseEventToKeybind(evt(3))).toBe("mouse4");
    expect(mouseEventToKeybind(evt(1, { ctrlKey: true }))).toBe("ctrl+mouse3");
    expect(mouseEventToKeybind(evt(4, { ctrlKey: true, shiftKey: true }))).toBe(
        "ctrl+shift+mouse5",
    );
    expect(mouseEventToKeybind(evt(0))).toBeNull();
    expect(mouseEventToKeybind(evt(2, { ctrlKey: true }))).toBeNull();
});

test("matchesMouseKeybind requires the exact button and modifier state", () => {
    expect(matchesMouseKeybind("mouse4", evt(3))).toBe(true);
    expect(matchesMouseKeybind("mouse4", evt(1))).toBe(false);
    expect(matchesMouseKeybind("mouse4", evt(3, { ctrlKey: true }))).toBe(false);
    expect(matchesMouseKeybind("ctrl+mouse4", evt(3, { ctrlKey: true }))).toBe(true);
    expect(matchesMouseKeybind("ctrl+mouse4", evt(3))).toBe(false);
    expect(matchesMouseKeybind("shift+mouse5", evt(4, { shiftKey: true }))).toBe(true);
});

test("matchesMouseKeybind never matches left or right click", () => {
    expect(matchesMouseKeybind("mouse3", evt(0))).toBe(false);
    expect(matchesMouseKeybind("mouse3", evt(2))).toBe(false);
});

test("matchesMouseKeybind handles a comma-separated binding list", () => {
    expect(matchesMouseKeybind("arrowright,mouse5", evt(4))).toBe(true);
});
