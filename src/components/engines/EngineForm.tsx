import { Button, Input, NumberInput, Text, TextInput } from "@mantine/core";
import type { UseFormReturnType } from "@mantine/form";
import { open } from "@tauri-apps/plugin-dialog";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { commands, type UciOptionConfig } from "@/bindings";
import { createVariant, type LocalEngine, requiredEngineSettings } from "@/utils/engines";
import { usePlatform } from "@/utils/files";
import { unwrap } from "@/utils/unwrap";
import FileInput from "../common/FileInput";

import { useAtom } from "jotai";
import { storedSyzygyPathAtom } from "@/state/atoms";

import { resolve } from "@tauri-apps/api/path";
import { copyFile, exists } from "@tauri-apps/plugin-fs";
import { getEnginesDir } from "@/utils/directories";

export default function EngineForm({
  onSubmit,
  form,
  submitLabel,
}: {
  onSubmit: (values: LocalEngine) => void;
  form: UseFormReturnType<LocalEngine, (values: LocalEngine) => LocalEngine>;
  submitLabel: string;
}) {
  const { t } = useTranslation();
  const [syzygyPath] = useAtom(storedSyzygyPathAtom);

  const { os } = usePlatform();
  const config = useRef<{ name: string; options: UciOptionConfig[] } | null>(null);
  const settings = config.current?.options
    .filter(
      (o) =>
        requiredEngineSettings.includes(o.value.name) ||
        o.value.name.toLowerCase() === "syzygypath",
    )
    .filter((o) => o.type !== "button")
    .map((o) => ({
      name: o.value.name,
      value:
        o.value.name.toLowerCase() === "syzygypath" && syzygyPath
          ? syzygyPath
          : (o.value.default as string | number | boolean),
    }));

  const filters = match(os)
    .with("windows", () => [{ name: "Executable Files", extensions: ["exe"] }])
    .otherwise(() => []);

  return (
    <form
      onSubmit={form.onSubmit(async (values) =>
        onSubmit({ ...values, loaded: true, variants: [createVariant("Default", settings || [])] }),
      )}
    >
      <FileInput
        label={t("Engines.Add.BinaryFile")}
        description={t("Engines.Add.BinaryFile.Desc")}
        filename={form.values.path}
        withAsterisk
        onClick={async () => {
          const selected = await open({
            multiple: false,
            filters,
          });
          if (!selected || typeof selected !== "string") return;

          const enginesDir = await getEnginesDir();
          const binaryName = selected.split(/[/\\]/).pop() || "engine";
          const destPath = await resolve(enginesDir, binaryName);

          if (selected !== destPath) {
            try {
              await copyFile(selected, destPath);
            } catch (e) {
              console.error("Failed to copy engine binary to app engines directory:", e);
            }
          }

          const targetPath = (await exists(destPath)) ? destPath : selected;
          config.current = unwrap(await commands.getEngineConfig(targetPath));
          form.setFieldValue("path", targetPath);
          form.setFieldValue("name", config.current.name);
        }}
      />

      <TextInput
        label={t("Engines.Add.Name")}
        placeholder={t("Engines.Add.Name.Autodetect")}
        withAsterisk
        {...form.getInputProps("name")}
      />

      <NumberInput
        label="Elo"
        placeholder={t("Engines.Add.Elo.Desc")}
        {...form.getInputProps("elo")}
      />

      <Input.Wrapper
        label={t("Engines.Add.ImageFile")}
        description={t("Engines.Add.ImageFile.Desc")}
        {...form.getInputProps("image")}
      >
        <Input
          component="button"
          type="button"
          onClick={async () => {
            const selected = await open({
              multiple: false,
              filters: [
                {
                  name: "Image",
                  extensions: ["png", "jpeg", "jpg", "svg", "webp"],
                },
              ],
            });
            if (!selected || typeof selected !== "string") return;

            const enginesDir = await getEnginesDir();
            const imageName = selected.split(/[/\\]/).pop() || "engine_image.png";
            const destPath = await resolve(enginesDir, imageName);

            if (selected !== destPath) {
              try {
                await copyFile(selected, destPath);
              } catch (e) {
                console.error("Failed to copy engine image to app engines directory:", e);
              }
            }

            const targetImagePath = (await exists(destPath)) ? destPath : selected;
            form.setFieldValue("image", targetImagePath);
          }}
        >
          <Text lineClamp={1}>{form.values.image}</Text>
        </Input>
      </Input.Wrapper>

      <Button fullWidth mt="xl" type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}
