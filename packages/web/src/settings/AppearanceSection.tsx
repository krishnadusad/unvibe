/**
 * Appearance section (Settings -> Appearance, issue #196): the UI theme
 * picker and the light/dark mode toggle. Themes are independent of
 * light/dark: each theme supplies both sets, and the mode toggle picks
 * one (or follows the system). Either choice applies at once and saves
 * like every other setting (PUT /api/settings); the boot script
 * re-applies both before first paint on the next load.
 */
import { useState } from "react";
import { COLOR_MODES, UI_THEMES, type ColorModeId, type Settings, type UiThemeId } from "@unvibe/shared";
import { api } from "../api/client.js";
import { applyColorMode, applyUiTheme, currentColorMode, currentUiTheme } from "../theme/theme.js";
import { putErrors } from "./LimitsSection.js";
import { Button, Card, Field, Select } from "../ui/index.js";

export function AppearanceSection({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (next: Settings) => void;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const selected: UiThemeId = settings.uiTheme ?? currentUiTheme();
  const mode: ColorModeId = settings.colorMode ?? currentColorMode();

  // Apply at once, save, and roll back the page if the save fails.
  const save = async (patch: Partial<Settings>, apply: () => void, undo: () => void): Promise<void> => {
    if (saving) return;
    apply();
    setSaving(true);
    setErrors([]);
    setSavedNote(null);
    try {
      const next = await api.saveSettings(patch);
      onSaved(next);
      setSavedNote("Saved");
    } catch (err) {
      undo();
      setErrors(putErrors(err));
    } finally {
      setSaving(false);
    }
  };

  const pick = async (theme: UiThemeId): Promise<void> => {
    if (theme === selected) return;
    const previous = selected;
    await save({ uiTheme: theme }, () => applyUiTheme(theme), () => applyUiTheme(previous));
  };

  const pickMode = async (next: ColorModeId): Promise<void> => {
    if (next === mode) return;
    const previous = mode;
    await save({ colorMode: next }, () => applyColorMode(next), () => applyColorMode(previous));
  };

  return (
    <section aria-label="Appearance">
      <Card variant="raised">
        <Field
          label="Theme"
          htmlFor="ui-theme"
          help="Each theme has a light and a dark set; Mode below picks one."
          status={<>{errors.map((m) => (<span className="err" role="alert" key={m}>{m}</span>))}{savedNote ? <span className="hint">{savedNote}</span> : null}</>}
        >
          <Select
            id="ui-theme"
            data-testid="ui-theme"
            value={selected}
            disabled={saving}
            onValueChange={(v) => void pick(v as UiThemeId)}
            options={UI_THEMES.map((t) => ({ value: t.id, label: t.label }))}
          />
        </Field>
        <Field label="Mode" help="System follows your computer's light or dark setting.">
          <div className="mode-toggle" role="group" aria-label="Mode" data-testid="color-mode">
            {COLOR_MODES.map((m) => (
              <Button
                key={m.id}
                type="button"
                size="sm"
                variant={m.id === mode ? "primary" : "secondary"}
                aria-pressed={m.id === mode}
                data-mode={m.id}
                disabled={saving}
                onClick={() => void pickMode(m.id)}
              >
                {m.label}
              </Button>
            ))}
          </div>
        </Field>
      </Card>
    </section>
  );
}
