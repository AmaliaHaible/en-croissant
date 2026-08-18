import { Anchor, Modal, Text } from "@mantine/core";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { arch, version as OSVersion, type } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";

function AboutModal({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [info, setInfo] = useState<{
    version: string;
    tauri: string;
    os: string;
    architecture: string;
    osVersion: string;
  } | null>(null);

  useEffect(() => {
    async function load() {
      const os = await type();
      const version = await getVersion();
      const tauri = await getTauriVersion();
      const architecture = await arch();
      const osVersion = await OSVersion();
      setInfo({ version, tauri, os, architecture, osVersion });
    }
    load();
  }, []);
  return (
    <Modal centered opened={opened} onClose={() => setOpened(false)} title="En Croissant 2.0">
      <Text fw={600}>En Croissant 2.0</Text>
      <Text size="sm" c="dimmed">
        The Ultimate Modern Chess Toolkit & Database
      </Text>
      <Text size="sm" mt="xs">
        Maintained & Developed by{" "}
        <Anchor href="https://github.com/jaipkapoor99" target="_blank" rel="noreferrer">
          Jai Kapoor (@jaipkapoor99)
        </Anchor>
      </Text>

      <br />

      <Text size="sm">Version: {info?.version}</Text>
      <Text size="sm">Tauri version: {info?.tauri}</Text>
      <Text size="sm">
        OS: {info?.os} {info?.architecture} {info?.osVersion}
      </Text>

      <br />

      <Anchor href="https://github.com/jaipkapoor99/en-croissant" target="_blank" rel="noreferrer">
        GitHub Repository
      </Anchor>
    </Modal>
  );
}

export default AboutModal;
