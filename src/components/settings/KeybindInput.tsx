import { ActionIcon, Box, Group, Kbd } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { platform } from "@tauri-apps/plugin-os";
import cx from "clsx";
import { useAtom, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { useRecordHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { keyMapAtom } from "@/state/keybinds";
import { mouseButtonToken, mouseEventToKeybind } from "@/utils/keybind";
import classes from "./KeybindInput.module.css";

const MOUSE_LABELS: Record<string, string> = {
  mouse3: "MB3",
  mouse4: "MB4",
  mouse5: "MB5",
};

function KeybindInput({
  action,
  keybind,
}: {
  action: string;
  keybind: {
    name: string;
    keys: string;
  };
}) {
  const [hovering, setHovering] = useState(false);

  const [keys, { start, stop, isRecording }] = useRecordHotkeys();
  const setKeymap = useSetAtom(keyMapAtom);

  // `useRecordHotkeys` only listens for the keyboard; capture mouse buttons here
  // so MB3/MB4/MB5 (optionally with modifiers) can be bound too.
  useEffect(() => {
    if (!isRecording) return;

    const onMouseDown = (event: MouseEvent) => {
      const binding = mouseEventToKeybind(event);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      stop();
      setKeymap((prev) => ({
        ...prev,
        [action]: { name: prev[action].name, keys: binding },
      }));
    };
    const onAuxClick = (event: MouseEvent) => {
      if (mouseButtonToken(event.button)) event.preventDefault();
    };

    window.addEventListener("mousedown", onMouseDown, { capture: true });
    window.addEventListener("auxclick", onAuxClick, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("auxclick", onAuxClick, { capture: true });
    };
  }, [isRecording, action, stop, setKeymap]);

  return (
    <>
      {!isRecording ? (
        <Box
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onClick={() => start()}
        >
          <KbdDisplay keys={keybind.keys} hovering={hovering} />
        </Box>
      ) : (
        <ShortcutInput keys={keys} stop={stop} action={action} />
      )}
    </>
  );
}

const mapToOs = (key: string): string => {
  if (MOUSE_LABELS[key]) {
    return MOUSE_LABELS[key];
  }

  const isMacos = platform() === "macos";

  if (!isMacos) {
    return key === "meta" ? "ctrl" : key;
  }

  if (key === "meta" || key === "cmd") {
    return "⌘";
  } else if (key === "ctrl") {
    return "⌃";
  } else if (key === "shift") {
    return "⇧";
  } else if (key === "alt") {
    return "⌥";
  }

  return key;
};

function KbdDisplay({ keys, hovering }: { keys: string; hovering: boolean }) {
  const splitted = keys.split("+");
  return (
    <Group>
      {splitted.map(mapToOs).map((key, i) => (
        <Group key={key}>
          <Kbd className={cx({ [classes.kbd]: hovering })}>{key}</Kbd>
          {i !== splitted.length - 1 && "+"}
        </Group>
      ))}
    </Group>
  );
}

function ShortcutInput({
  keys,
  action,
  stop,
}: {
  keys: Set<string>;
  action: string;
  stop: () => void;
}) {
  const { t } = useTranslation();
  const [, setKeymap] = useAtom(keyMapAtom);
  const stringed = Array.from(keys).join("+");

  return (
    <Group>
      {stringed === "" ? (
        <Kbd>{t("Settings.Keybinds.PressAnyKey")}</Kbd>
      ) : (
        <KbdDisplay keys={stringed} hovering={false} />
      )}
      <ActionIcon
        variant="outline"
        color="red"
        onClick={() => {
          stop();
        }}
      >
        <IconX />
      </ActionIcon>
      <ActionIcon
        variant="outline"
        color="green"
        disabled={stringed === ""}
        onClick={() => {
          stop();
          setKeymap((prev) => ({
            ...prev,
            [action]: {
              name: prev[action].name,
              keys: stringed,
            },
          }));
        }}
      >
        <IconCheck />
      </ActionIcon>
    </Group>
  );
}

export default KeybindInput;
