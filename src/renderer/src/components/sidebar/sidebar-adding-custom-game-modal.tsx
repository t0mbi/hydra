import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  DeviceDesktopIcon,
  FileDirectoryIcon,
  XIcon,
} from "@primer/octicons-react";

import { Modal, TextField, Button } from "@renderer/components";
import {
  useLibrary,
  useSteamMatchSearch,
  useToast,
  type SteamMatchSuggestion,
} from "@renderer/hooks";
import {
  buildGameDetailsPath,
  generateRandomGradient,
} from "@renderer/helpers";
import { LINUX_GAME_EXECUTABLE_EXTENSIONS } from "@shared";
import { logger } from "@renderer/logger";
import type {
  InstalledUwpApp,
  InstalledSteamApp,
  InstalledEpicApp,
  ShopAssets,
} from "@types";

import "./sidebar-adding-custom-game-modal.scss";

export interface SidebarAddingCustomGameModalProps {
  visible: boolean;
  onClose: () => void;
  initialExecutablePath?: string;
}

type InstalledAppSource = "uwp" | "steam" | "epic";

type SelectedInstalledApp =
  | { source: "uwp"; app: InstalledUwpApp }
  | { source: "steam"; app: InstalledSteamApp }
  | { source: "epic"; app: InstalledEpicApp };

// Shortcut filenames and free-typed search terms often drop punctuation
// Windows/Steam/Epic keep in the real display name (e.g.
// "Halo Campaign Evolved" vs. "Halo: Campaign Evolved") -- normalize both
// sides the same way the main-process UWP resolver does so those still
// match.
const normalizeForSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function SidebarAddingCustomGameModal({
  visible,
  onClose,
  initialExecutablePath,
}: Readonly<SidebarAddingCustomGameModalProps>) {
  const { t } = useTranslation("sidebar");
  const { updateLibrary } = useLibrary();
  const { showSuccessToast, showErrorToast } = useToast();
  const navigate = useNavigate();

  const [gameName, setGameName] = useState("");
  const [executablePath, setExecutablePath] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [matchedGame, setMatchedGame] = useState<SteamMatchSuggestion | null>(
    null
  );
  const [matchedAssets, setMatchedAssets] = useState<ShopAssets | null>(null);
  // Tracks which match is currently "active" so an asset fetch for a match
  // the user has since changed away from can't clobber newer state.
  const matchedGameRef = useRef<SteamMatchSuggestion | null>(null);

  // Microsoft Store/Xbox, Steam, and Epic Games apps have no real
  // executablePath to browse to -- picking one here replaces the whole
  // "select an executable" step, since the app is already fully identified
  // (launch id + install folder) straight from that source's own installed-
  // app list. See list-installed-uwp-apps.ts / list-installed-steam-apps.ts
  // / list-installed-epic-apps.ts.
  const [selectedInstalledApp, setSelectedInstalledApp] =
    useState<SelectedInstalledApp | null>(null);

  const [showUwpBrowser, setShowUwpBrowser] = useState(false);
  const [uwpApps, setUwpApps] = useState<InstalledUwpApp[]>([]);
  const [isLoadingUwpApps, setIsLoadingUwpApps] = useState(false);
  const [uwpFilter, setUwpFilter] = useState("");

  const [showSteamBrowser, setShowSteamBrowser] = useState(false);
  const [steamApps, setSteamApps] = useState<InstalledSteamApp[]>([]);
  const [isLoadingSteamApps, setIsLoadingSteamApps] = useState(false);
  const [steamFilter, setSteamFilter] = useState("");

  const [showEpicBrowser, setShowEpicBrowser] = useState(false);
  const [epicApps, setEpicApps] = useState<InstalledEpicApp[]>([]);
  const [isLoadingEpicApps, setIsLoadingEpicApps] = useState(false);
  const [epicFilter, setEpicFilter] = useState("");

  const {
    suggestions: steamSuggestions,
    isSearching: isSearchingSteam,
    clearSuggestions,
  } = useSteamMatchSearch(gameName, !matchedGame);

  // Matches to a real Steam catalogue entry and pulls in its official
  // cover/hero/logo art, instead of leaving the game with none. Shared by
  // both the "Is this one of these Steam games?" suggestion click (a fuzzy
  // title match the user confirms) and picking an app from "browse
  // installed Steam games" (an exact appid, no confirmation needed).
  const applySteamMatch = (
    objectId: string,
    title: string,
    iconUrl: string | null
  ) => {
    const suggestion: SteamMatchSuggestion = {
      objectId,
      title,
      shop: "steam",
      iconUrl,
    };
    matchedGameRef.current = suggestion;
    setMatchedGame(suggestion);
    clearSuggestions();
    setMatchedAssets(null);

    window.electron
      .getGameAssets(objectId, "steam")
      .then((assets) => {
        if (matchedGameRef.current?.objectId !== objectId) return;
        setMatchedAssets(assets);
      })
      .catch((error) => {
        if (matchedGameRef.current?.objectId !== objectId) return;
        logger.error("Failed to fetch matched Steam game assets", error);
      });
  };

  const handleSelectInstalledApp = (app: SelectedInstalledApp) => {
    setSelectedInstalledApp(app);
    setExecutablePath("");
    setGameName(app.app.name);
    setShowUwpBrowser(false);
    setShowSteamBrowser(false);
    setShowEpicBrowser(false);

    if (app.source === "steam") {
      // The Steam picker already has the real, exact Steam appid -- unlike
      // Xbox/Epic, there's no name ambiguity to resolve, so match it
      // immediately instead of leaving the game with no cover art at all.
      applySteamMatch(app.app.appId, app.app.name, null);
      return;
    }

    matchedGameRef.current = null;
    setMatchedGame(null);
    setMatchedAssets(null);
  };

  useEffect(() => {
    if (!visible || !initialExecutablePath) return;

    const fileName = initialExecutablePath.split(/[\\/]/).pop() || "";
    const gameNameFromFile = fileName.replace(/\.[^/.]+$/, "");

    // Xbox/Game Pass and Steam desktop shortcuts have no real target to
    // just drop in the executable field (Steam's .lnk target is steam.exe
    // with "-applaunch <appid>", newer Steam versions write a plain .url
    // "Internet Shortcut" file with a steam://rungameid/<appid> URL instead
    // of a .lnk, and on Linux the equivalent is a freedesktop .desktop
    // entry whose Exec= line invokes the same URI -- either way,
    // spawning/opening it directly just opens the Steam client, not the
    // game) -- resolve the drop through the same lookup the manual
    // "browse installed apps" flow uses, and surface it the same way,
    // instead of leaving the user with an unusable/misleading path.
    const droppedPathLower = initialExecutablePath.toLowerCase();
    const isWindowsShortcut =
      window.electron.platform === "win32" &&
      (droppedPathLower.endsWith(".lnk") || droppedPathLower.endsWith(".url"));
    const isLinuxDesktopEntry =
      window.electron.platform === "linux" &&
      droppedPathLower.endsWith(".desktop");

    if (isWindowsShortcut || isLinuxDesktopEntry) {
      window.electron
        .resolveDroppedExecutable(initialExecutablePath)
        .then((result) => {
          if (result.kind === "plain") {
            setExecutablePath(initialExecutablePath);
            setGameName(gameNameFromFile);
            return;
          }

          if (result.resolvedApp) {
            handleSelectInstalledApp(
              result.kind === "microsoft-store"
                ? { source: "uwp", app: result.resolvedApp }
                : { source: "steam", app: result.resolvedApp }
            );
            return;
          }

          // Recognized as a Store/Steam shortcut but no confident match --
          // open the matching picker pre-filtered so the user can pick
          // manually.
          setGameName(gameNameFromFile);

          if (result.kind === "microsoft-store") {
            setUwpFilter(gameNameFromFile);
            setShowUwpBrowser(true);
            setIsLoadingUwpApps(true);
            window.electron
              .listInstalledUwpApps()
              .then(setUwpApps)
              .catch((error) => {
                logger.error(
                  "Failed to list installed Microsoft Store apps",
                  error
                );
                setUwpApps([]);
              })
              .finally(() => setIsLoadingUwpApps(false));
          } else {
            setSteamFilter(gameNameFromFile);
            setShowSteamBrowser(true);
            setIsLoadingSteamApps(true);
            window.electron
              .listInstalledSteamApps()
              .then(setSteamApps)
              .catch((error) => {
                logger.error("Failed to list installed Steam apps", error);
                setSteamApps([]);
              })
              .finally(() => setIsLoadingSteamApps(false));
          }
        })
        .catch((error) => {
          logger.error("Failed to resolve dropped shortcut", error);
          setExecutablePath(initialExecutablePath);
          setGameName(gameNameFromFile);
        });
      return;
    }

    setExecutablePath(initialExecutablePath);
    setGameName(gameNameFromFile);
    // handleSelectInstalledApp is stable across renders (no external deps beyond setters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialExecutablePath]);

  const handleSelectExecutable = async () => {
    const filters =
      window.electron.platform === "linux"
        ? [
            {
              name: t("custom_game_modal_executable"),
              extensions: LINUX_GAME_EXECUTABLE_EXTENSIONS,
            },
            { name: t("all_files", { ns: "game_details" }), extensions: ["*"] },
          ]
        : [
            {
              name: t("custom_game_modal_executable"),
              extensions: [
                "exe",
                "msi",
                "bat",
                "cmd",
                "app",
                "deb",
                "rpm",
                "dmg",
              ],
            },
          ];

    const { filePaths } = await window.electron.showOpenDialog({
      properties: ["openFile"],
      filters,
    });

    if (filePaths && filePaths.length > 0) {
      const selectedPath = filePaths[0];
      setExecutablePath(selectedPath);

      if (!gameName.trim()) {
        const fileName = selectedPath.split(/[\\/]/).pop() || "";
        const gameNameFromFile = fileName.replace(/\.[^/.]+$/, "");
        setGameName(gameNameFromFile);
      }
    }
  };

  const toggleInstalledAppBrowser = async <T,>(
    source: InstalledAppSource,
    isVisible: boolean,
    setVisible: (value: boolean) => void,
    setLoading: (value: boolean) => void,
    setApps: (apps: T[]) => void,
    listFn: (forceRefresh?: boolean) => Promise<T[]>
  ) => {
    if (isVisible) {
      setVisible(false);
      return;
    }

    setVisible(true);
    setLoading(true);

    try {
      setApps(await listFn());
    } catch (error) {
      logger.error(`Failed to list installed ${source} apps`, error);
      setApps([]);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleUwpBrowser = () =>
    toggleInstalledAppBrowser(
      "uwp",
      showUwpBrowser,
      setShowUwpBrowser,
      setIsLoadingUwpApps,
      setUwpApps,
      window.electron.listInstalledUwpApps
    );

  const handleToggleSteamBrowser = () =>
    toggleInstalledAppBrowser(
      "steam",
      showSteamBrowser,
      setShowSteamBrowser,
      setIsLoadingSteamApps,
      setSteamApps,
      window.electron.listInstalledSteamApps
    );

  const handleToggleEpicBrowser = () =>
    toggleInstalledAppBrowser(
      "epic",
      showEpicBrowser,
      setShowEpicBrowser,
      setIsLoadingEpicApps,
      setEpicApps,
      window.electron.listInstalledEpicApps
    );

  const handleClearInstalledApp = () => {
    setSelectedInstalledApp(null);
    setGameName("");
    // Clears the Steam auto-match applied alongside a Steam-picker pick
    // (see applySteamMatch) so it doesn't linger as an orphaned "matched"
    // chip once the pick itself is gone.
    matchedGameRef.current = null;
    setMatchedGame(null);
    setMatchedAssets(null);
  };

  const filteredUwpApps = uwpApps.filter((app) =>
    normalizeForSearch(app.name).includes(normalizeForSearch(uwpFilter))
  );
  const filteredSteamApps = steamApps.filter((app) =>
    normalizeForSearch(app.name).includes(normalizeForSearch(steamFilter))
  );
  const filteredEpicApps = epicApps.filter((app) =>
    normalizeForSearch(app.name).includes(normalizeForSearch(epicFilter))
  );

  const handleGameNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setGameName(event.target.value);

    if (matchedGame) {
      matchedGameRef.current = null;
      setMatchedGame(null);
      setMatchedAssets(null);
    }
  };

  const handleSelectMatch = (suggestion: SteamMatchSuggestion) => {
    applySteamMatch(suggestion.objectId, suggestion.title, suggestion.iconUrl);
    setGameName(suggestion.title);
  };

  const handleClearMatch = () => {
    matchedGameRef.current = null;
    setMatchedGame(null);
    setMatchedAssets(null);
  };

  const handleAddGame = async () => {
    if (!gameName.trim() || (!executablePath.trim() && !selectedInstalledApp)) {
      showErrorToast(t("custom_game_modal_fill_required"));
      return;
    }

    setIsAdding(true);

    try {
      const gameNameForSeed = gameName.trim();
      // Use the matched Steam game's real artwork when available; otherwise
      // fall back to no icon/logo and a generated gradient hero.
      const iconUrl = matchedAssets?.iconUrl || "";
      const logoImageUrl = matchedAssets?.logoImageUrl || "";
      const libraryHeroImageUrl =
        matchedAssets?.libraryHeroImageUrl || generateRandomGradient();
      const customCoverImageUrl = matchedAssets?.coverImageUrl || null;
      const matchedSteamObjectId = matchedGame?.objectId ?? null;

      const newGame = selectedInstalledApp
        ? selectedInstalledApp.source === "uwp"
          ? await window.electron.addUwpAppToLibrary(
              gameNameForSeed,
              selectedInstalledApp.app.appId,
              selectedInstalledApp.app.installLocation,
              iconUrl,
              logoImageUrl,
              libraryHeroImageUrl,
              matchedSteamObjectId,
              customCoverImageUrl
            )
          : selectedInstalledApp.source === "steam"
            ? await window.electron.addSteamAppToLibrary(
                gameNameForSeed,
                selectedInstalledApp.app.appId,
                selectedInstalledApp.app.installLocation,
                iconUrl,
                logoImageUrl,
                libraryHeroImageUrl,
                matchedSteamObjectId,
                customCoverImageUrl
              )
            : await window.electron.addEpicAppToLibrary(
                gameNameForSeed,
                selectedInstalledApp.app.appName,
                selectedInstalledApp.app.installLocation,
                iconUrl,
                logoImageUrl,
                libraryHeroImageUrl,
                matchedSteamObjectId,
                customCoverImageUrl
              )
        : await window.electron.addCustomGameToLibrary(
            gameNameForSeed,
            executablePath,
            iconUrl,
            logoImageUrl,
            libraryHeroImageUrl,
            matchedSteamObjectId,
            customCoverImageUrl
          );

      showSuccessToast(t("custom_game_modal_success"));
      updateLibrary();

      const gameDetailsPath = buildGameDetailsPath({
        shop: "custom",
        objectId: newGame.objectId,
        title: newGame.title,
      });

      navigate(gameDetailsPath);

      setGameName("");
      setExecutablePath("");
      setSelectedInstalledApp(null);
      matchedGameRef.current = null;
      setMatchedGame(null);
      setMatchedAssets(null);
      onClose();
    } catch (error) {
      console.error("Failed to add custom game:", error);
      showErrorToast(
        error instanceof Error ? error.message : t("custom_game_modal_failed")
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleClose = () => {
    if (!isAdding) {
      setGameName("");
      setExecutablePath("");
      setSelectedInstalledApp(null);
      setShowUwpBrowser(false);
      setUwpFilter("");
      setShowSteamBrowser(false);
      setSteamFilter("");
      setShowEpicBrowser(false);
      setEpicFilter("");
      matchedGameRef.current = null;
      setMatchedGame(null);
      setMatchedAssets(null);
      onClose();
    }
  };

  const isFormValid =
    gameName.trim() && (executablePath.trim() || selectedInstalledApp);

  const selectedAppChipLabel = selectedInstalledApp
    ? t(
        selectedInstalledApp.source === "uwp"
          ? "custom_game_modal_uwp_selected"
          : selectedInstalledApp.source === "steam"
            ? "custom_game_modal_steam_selected"
            : "custom_game_modal_epic_selected",
        { name: selectedInstalledApp.app.name }
      )
    : "";

  return (
    <Modal
      visible={visible}
      title={t("custom_game_modal")}
      description={t("custom_game_modal_description")}
      onClose={handleClose}
    >
      <div className="sidebar-adding-custom-game-modal__container">
        <div className="sidebar-adding-custom-game-modal__form">
          {selectedInstalledApp ? (
            <div className="sidebar-adding-custom-game-modal__match">
              <DeviceDesktopIcon size={16} />
              <span className="sidebar-adding-custom-game-modal__match-label">
                {selectedAppChipLabel}
              </span>
              <button
                type="button"
                className="sidebar-adding-custom-game-modal__match-clear"
                onClick={handleClearInstalledApp}
                disabled={isAdding}
                aria-label={t("custom_game_modal_match_clear")}
              >
                <XIcon size={14} />
              </button>
            </div>
          ) : (
            <>
              <TextField
                label={t("custom_game_modal_executable_path")}
                placeholder={t("custom_game_modal_select_executable")}
                value={executablePath}
                readOnly
                theme="dark"
                rightContent={
                  <Button
                    type="button"
                    theme="outline"
                    onClick={handleSelectExecutable}
                    disabled={isAdding}
                  >
                    <FileDirectoryIcon />
                    {t("custom_game_modal_browse")}
                  </Button>
                }
              />

              {window.electron.platform === "win32" && (
                <button
                  type="button"
                  className="sidebar-adding-custom-game-modal__uwp-toggle"
                  onClick={handleToggleUwpBrowser}
                  disabled={isAdding}
                >
                  <DeviceDesktopIcon size={14} />
                  {t("custom_game_modal_browse_uwp")}
                </button>
              )}

              {showUwpBrowser && (
                <div className="sidebar-adding-custom-game-modal__suggestions">
                  <TextField
                    placeholder={t("custom_game_modal_uwp_filter")}
                    value={uwpFilter}
                    onChange={(event) => setUwpFilter(event.target.value)}
                    theme="dark"
                  />

                  {isLoadingUwpApps ? (
                    <span className="sidebar-adding-custom-game-modal__suggestions-title">
                      {t("custom_game_modal_uwp_loading")}
                    </span>
                  ) : filteredUwpApps.length === 0 ? (
                    <span className="sidebar-adding-custom-game-modal__suggestions-title">
                      {t("custom_game_modal_uwp_empty")}
                    </span>
                  ) : (
                    <ul className="sidebar-adding-custom-game-modal__suggestions-list">
                      {filteredUwpApps.map((app) => (
                        <li key={app.appId}>
                          <button
                            type="button"
                            className="sidebar-adding-custom-game-modal__suggestion"
                            onClick={() =>
                              handleSelectInstalledApp({ source: "uwp", app })
                            }
                            disabled={isAdding}
                          >
                            {app.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <button
                type="button"
                className="sidebar-adding-custom-game-modal__uwp-toggle"
                onClick={handleToggleSteamBrowser}
                disabled={isAdding}
              >
                <DeviceDesktopIcon size={14} />
                {t("custom_game_modal_browse_steam")}
              </button>

              {showSteamBrowser && (
                <div className="sidebar-adding-custom-game-modal__suggestions">
                  <TextField
                    placeholder={t("custom_game_modal_uwp_filter")}
                    value={steamFilter}
                    onChange={(event) => setSteamFilter(event.target.value)}
                    theme="dark"
                  />

                  {isLoadingSteamApps ? (
                    <span className="sidebar-adding-custom-game-modal__suggestions-title">
                      {t("custom_game_modal_uwp_loading")}
                    </span>
                  ) : filteredSteamApps.length === 0 ? (
                    <span className="sidebar-adding-custom-game-modal__suggestions-title">
                      {t("custom_game_modal_uwp_empty")}
                    </span>
                  ) : (
                    <ul className="sidebar-adding-custom-game-modal__suggestions-list">
                      {filteredSteamApps.map((app) => (
                        <li key={app.appId}>
                          <button
                            type="button"
                            className="sidebar-adding-custom-game-modal__suggestion"
                            onClick={() =>
                              handleSelectInstalledApp({ source: "steam", app })
                            }
                            disabled={isAdding}
                          >
                            {app.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <button
                type="button"
                className="sidebar-adding-custom-game-modal__uwp-toggle"
                onClick={handleToggleEpicBrowser}
                disabled={isAdding}
              >
                <DeviceDesktopIcon size={14} />
                {t("custom_game_modal_browse_epic")}
              </button>

              {showEpicBrowser && (
                <div className="sidebar-adding-custom-game-modal__suggestions">
                  <TextField
                    placeholder={t("custom_game_modal_uwp_filter")}
                    value={epicFilter}
                    onChange={(event) => setEpicFilter(event.target.value)}
                    theme="dark"
                  />

                  {isLoadingEpicApps ? (
                    <span className="sidebar-adding-custom-game-modal__suggestions-title">
                      {t("custom_game_modal_uwp_loading")}
                    </span>
                  ) : filteredEpicApps.length === 0 ? (
                    <span className="sidebar-adding-custom-game-modal__suggestions-title">
                      {t("custom_game_modal_uwp_empty")}
                    </span>
                  ) : (
                    <ul className="sidebar-adding-custom-game-modal__suggestions-list">
                      {filteredEpicApps.map((app) => (
                        <li key={app.appName}>
                          <button
                            type="button"
                            className="sidebar-adding-custom-game-modal__suggestion"
                            onClick={() =>
                              handleSelectInstalledApp({ source: "epic", app })
                            }
                            disabled={isAdding}
                          >
                            {app.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          <TextField
            label={t("custom_game_modal_title")}
            placeholder={t("custom_game_modal_enter_title")}
            value={gameName}
            onChange={handleGameNameChange}
            theme="dark"
            disabled={isAdding}
          />

          {/* The "browse installed Steam games" picker already matches an
              exact appid (see applySteamMatch) -- its own chip above already
              says as much, so don't also show this generic "matched on
              Steam" confirmation for it. */}
          {selectedInstalledApp?.source === "steam" ? null : matchedGame ? (
            <div className="sidebar-adding-custom-game-modal__match">
              {matchedGame.iconUrl && (
                <img
                  src={matchedGame.iconUrl}
                  alt=""
                  className="sidebar-adding-custom-game-modal__match-icon"
                />
              )}
              <span className="sidebar-adding-custom-game-modal__match-label">
                {t("custom_game_modal_match_selected", {
                  title: matchedGame.title,
                })}
              </span>
              <button
                type="button"
                className="sidebar-adding-custom-game-modal__match-clear"
                onClick={handleClearMatch}
                disabled={isAdding}
                aria-label={t("custom_game_modal_match_clear")}
              >
                <XIcon size={14} />
              </button>
            </div>
          ) : (
            (isSearchingSteam || steamSuggestions.length > 0) && (
              <div className="sidebar-adding-custom-game-modal__suggestions">
                <span className="sidebar-adding-custom-game-modal__suggestions-title">
                  {isSearchingSteam
                    ? t("custom_game_modal_match_searching")
                    : t("custom_game_modal_match_steam_title")}
                </span>
                <ul className="sidebar-adding-custom-game-modal__suggestions-list">
                  {steamSuggestions.map((suggestion) => (
                    <li key={suggestion.objectId}>
                      <button
                        type="button"
                        className="sidebar-adding-custom-game-modal__suggestion"
                        onClick={() => handleSelectMatch(suggestion)}
                        disabled={isAdding}
                      >
                        {suggestion.iconUrl && (
                          <img src={suggestion.iconUrl} alt="" />
                        )}
                        {suggestion.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
        </div>

        <div className="sidebar-adding-custom-game-modal__actions">
          <Button
            type="button"
            theme="outline"
            onClick={handleClose}
            disabled={isAdding}
          >
            {t("custom_game_modal_cancel")}
          </Button>
          <Button
            type="button"
            theme="primary"
            onClick={handleAddGame}
            disabled={!isFormValid || isAdding}
          >
            {isAdding
              ? t("custom_game_modal_adding")
              : t("custom_game_modal_add")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
