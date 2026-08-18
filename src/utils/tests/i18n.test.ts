import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en_US from "../../translation/en-US.json";

describe("i18n translation resolution", () => {
    it("resolves translation keys correctly", async () => {
        const instance = i18n.createInstance();
        await instance.use(initReactI18next).init({
            resources: {
                "en-US": en_US,
            },
            lng: "en-US",
            fallbackLng: "en-US",
            returnEmptyString: false,
        });

        expect(instance.t("Common.Name")).toBe("Name");
        expect(instance.t("Common.GeneralSettings")).toBe("General settings");
        expect(instance.t("Board.Action.AddGame")).toBe("Add Game");
    });
});
