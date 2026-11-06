import { Input, Label } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { isTauri } from "../../../lib/is-tauri";
import { useSettingsDraft } from "./SettingsDraftContext";

/** Device-local navigation preferences, committed by the dialog's Save action. */
export function SpaceMouseSettings() {
  const { t } = useTranslation();
  const { draftDesktopSettings, setDraftDesktopSettings } = useSettingsDraft();
  if (!isTauri() || !navigator.userAgent.includes("Windows")) return null;
  const settings = draftDesktopSettings.spaceMouse;
  const update = (patch: Partial<typeof settings>) =>
    setDraftDesktopSettings((current) => ({
      ...current,
      spaceMouse: { ...current.spaceMouse, ...patch },
    }));
  return (
    <fieldset className="space-y-3 rounded border p-3">
      <legend className="px-1 text-sm font-semibold">{t("settings.spaceMouse.title")}</legend>
      <p className="text-xs text-muted-foreground">{t("settings.spaceMouse.description")}</p>
      <Label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        {t("settings.spaceMouse.enabled")}
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="spacemouse-sensitivity">{t("settings.spaceMouse.sensitivity")}</Label>
          <Input
            id="spacemouse-sensitivity"
            type="number"
            min={0.1}
            max={4}
            step={0.1}
            disabled={!settings.enabled}
            value={settings.sensitivity}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value))
                update({ sensitivity: Math.max(0.1, Math.min(4, value)) });
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="spacemouse-dead-zone">{t("settings.spaceMouse.deadZone")}</Label>
          <Input
            id="spacemouse-dead-zone"
            type="number"
            min={0}
            max={30}
            step={1}
            disabled={!settings.enabled}
            value={Math.round(settings.deadZone * 100)}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value))
                update({ deadZone: Math.max(0, Math.min(30, value)) / 100 });
            }}
          />
        </div>
      </div>
      <Label className="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={!settings.enabled}
          checked={settings.invertZoom}
          onChange={(event) => update({ invertZoom: event.target.checked })}
        />
        {t("settings.spaceMouse.invertZoom")}
      </Label>
      <p className="text-xs text-muted-foreground">{t("settings.spaceMouse.controls")}</p>
    </fieldset>
  );
}
