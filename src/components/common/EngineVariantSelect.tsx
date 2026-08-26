import { Select } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { LocalEngine } from "@/utils/engines";

/**
 * Picks one of an engine's saved variants. Self-heals like EnginesSelect: if the given
 * variantId doesn't belong to the current engine (missing, deleted, or engine just changed),
 * it snaps to that engine's first (default) variant instead of rendering an invalid selection.
 */
export function EngineVariantSelect({
  engine,
  variantId,
  setVariantId,
}: {
  engine: LocalEngine | null;
  variantId: string | null;
  setVariantId: (id: string) => void;
}) {
  const { t } = useTranslation();
  const variants = engine?.variants ?? [];

  useEffect(() => {
    if (variants.length === 0) return;
    if (!variantId || !variants.some((v) => v.id === variantId)) {
      setVariantId(variants[0].id);
    }
  }, [variants, variantId, setVariantId]);

  if (!engine) return null;

  return (
    <Select
      label={t("Board.Opponent.Variant", "Variant")}
      allowDeselect={false}
      data={variants.map((v) => ({ value: v.id, label: v.name }))}
      value={variantId ?? variants[0]?.id ?? ""}
      onChange={(v) => {
        if (v) setVariantId(v);
      }}
    />
  );
}
