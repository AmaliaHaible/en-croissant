import { ActionIcon, Button, Group, Modal, Select, Stack, TextInput, Tooltip } from "@mantine/core";
import { IconCopy, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canDeleteVariant,
  duplicateVariant,
  type EngineVariant,
  type LocalEngine,
} from "@/utils/engines";
import ConfirmModal from "../common/ConfirmModal";

function NamePromptModal({
  opened,
  title,
  initialName,
  onClose,
  onSubmit,
}: {
  opened: boolean;
  title: string;
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const { t } = useTranslation();

  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack>
        <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Group justify="end">
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onSubmit(name.trim());
              onClose();
            }}
          >
            {t("Common.Save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function VariantManager({
  engine,
  selectedVariantId,
  setSelectedVariantId,
  setEngine,
}: {
  engine: LocalEngine;
  selectedVariantId: string;
  setSelectedVariantId: (id: string) => void;
  setEngine: (engine: LocalEngine) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const variants = engine.variants;
  const selected = variants.find((v) => v.id === selectedVariantId) ?? variants[0];

  function replaceVariant(id: string, next: EngineVariant) {
    setEngine({
      ...engine,
      variants: variants.map((v) => (v.id === id ? next : v)),
    });
  }

  return (
    <>
      <Group align="end" wrap="nowrap">
        <Select
          flex={1}
          label={t("Engines.Settings.Variant", "Variant")}
          allowDeselect={false}
          data={variants.map((v) => ({ value: v.id, label: v.name }))}
          value={selected.id}
          onChange={(v) => v && setSelectedVariantId(v)}
        />
        <Tooltip label={t("Common.AddNew")}>
          <ActionIcon variant="default" size="lg" onClick={() => setAdding(true)}>
            <IconPlus size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Engines.Settings.RenameVariant", "Rename")}>
          <ActionIcon variant="default" size="lg" onClick={() => setRenaming(true)}>
            <IconPencil size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Common.Duplicate")}>
          <ActionIcon
            variant="default"
            size="lg"
            onClick={() => {
              const copy = duplicateVariant(selected, `${selected.name} (Copy)`);
              setEngine({ ...engine, variants: [...variants, copy] });
              setSelectedVariantId(copy.id);
            }}
          >
            <IconCopy size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Common.Remove")}>
          <ActionIcon
            variant="default"
            color="red"
            size="lg"
            disabled={!canDeleteVariant(variants.length)}
            onClick={() => setDeleting(true)}
          >
            <IconTrash size="1rem" />
          </ActionIcon>
        </Tooltip>
      </Group>

      <NamePromptModal
        opened={adding}
        title={t("Common.AddNew")}
        initialName={t("Engines.Settings.NewVariant", "New Variant")}
        onClose={() => setAdding(false)}
        onSubmit={(name) => {
          const copy = duplicateVariant(selected, name);
          setEngine({ ...engine, variants: [...variants, copy] });
          setSelectedVariantId(copy.id);
        }}
      />

      <NamePromptModal
        opened={renaming}
        title={t("Engines.Settings.RenameVariant", "Rename")}
        initialName={selected.name}
        onClose={() => setRenaming(false)}
        onSubmit={(name) => replaceVariant(selected.id, { ...selected, name })}
      />

      <ConfirmModal
        title={t("Common.Remove")}
        description={t("Engines.Settings.RemoveVariant", "Remove this variant?")}
        opened={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          const remaining = variants.filter((v) => v.id !== selected.id);
          setEngine({ ...engine, variants: remaining });
          setSelectedVariantId(remaining[0].id);
          setDeleting(false);
        }}
        confirmLabel={t("Common.Remove")}
      />
    </>
  );
}
