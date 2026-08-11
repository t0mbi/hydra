import { useContext, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { Button, CheckboxField, Link, TextField } from "@renderer/components";
import "./settings-steamgriddb.scss";

import { useAppSelector, useToast } from "@renderer/hooks";

import { settingsContext } from "@renderer/context";
import { LinkExternalIcon } from "@primer/octicons-react";

const STEAMGRIDDB_URL = "https://www.steamgriddb.com";
const STEAMGRIDDB_API_KEY_URL =
  "https://www.steamgriddb.com/profile/preferences/api";

export function SettingsSteamGridDb() {
  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const { updateUserPreferences } = useContext(settingsContext);

  const [isLoading, setIsLoading] = useState(false);
  const [form, setForm] = useState({
    useSteamGridDb: false,
    steamGridDbApiKey: null as string | null,
  });

  const { showSuccessToast, showErrorToast } = useToast();

  const { t } = useTranslation("settings");

  useEffect(() => {
    if (userPreferences) {
      setForm({
        useSteamGridDb: Boolean(userPreferences.steamGridDbApiKey),
        steamGridDbApiKey: userPreferences.steamGridDbApiKey ?? null,
      });
    }
  }, [userPreferences]);

  const handleFormSubmit: React.FormEventHandler<HTMLFormElement> = async (
    event
  ) => {
    setIsLoading(true);
    event.preventDefault();

    try {
      if (form.useSteamGridDb) {
        await window.electron.validateSteamGridDbApiKey(
          form.steamGridDbApiKey!
        );

        showSuccessToast(t("steamgriddb_key_linked"));
      } else {
        showSuccessToast(t("changes_saved"));
      }

      updateUserPreferences({
        steamGridDbApiKey: form.useSteamGridDb ? form.steamGridDbApiKey : null,
      });
    } catch (err) {
      showErrorToast(t("steamgriddb_invalid_key"));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSteamGridDb = () => {
    const updatedValue = !form.useSteamGridDb;

    setForm((prev) => ({
      ...prev,
      useSteamGridDb: updatedValue,
    }));

    if (!updatedValue) {
      updateUserPreferences({
        steamGridDbApiKey: null,
      });
    }
  };

  const isButtonDisabled =
    (form.useSteamGridDb && !form.steamGridDbApiKey) || isLoading;

  return (
    <form className="settings-steamgriddb__form" onSubmit={handleFormSubmit}>
      <div className="settings-steamgriddb__description-container">
        <p className="settings-steamgriddb__description">
          {t("steamgriddb_integration_description")}
        </p>
        <Link
          to={STEAMGRIDDB_URL}
          className="settings-steamgriddb__create-account"
        >
          <LinkExternalIcon />
          {t("create_steamgriddb_account")}
        </Link>
      </div>

      <CheckboxField
        label={t("enable_steamgriddb")}
        checked={form.useSteamGridDb}
        onChange={toggleSteamGridDb}
      />

      {form.useSteamGridDb && (
        <TextField
          label={t("steamgriddb_api_key")}
          value={form.steamGridDbApiKey ?? ""}
          type="password"
          onChange={(event) =>
            setForm({ ...form, steamGridDbApiKey: event.target.value })
          }
          rightContent={
            <Button type="submit" disabled={isButtonDisabled}>
              {t("test_connection")}
            </Button>
          }
          placeholder={t("steamgriddb_api_key")}
          hint={
            <Trans i18nKey="steamgriddb_api_key_hint" ns="settings">
              <Link to={STEAMGRIDDB_API_KEY_URL} />
            </Trans>
          }
        />
      )}
    </form>
  );
}
