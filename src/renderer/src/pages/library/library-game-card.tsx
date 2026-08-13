import { LibraryGame } from "@types";
import { useGameCard, isAnimatedCoverCandidate } from "@renderer/hooks";
import {
  CLASSICS_PS_PLATFORM_LABELS,
  resolveClassicsBadge,
  getCustomGameBadgeKind,
} from "@renderer/helpers";
import { AchievementProgress } from "@renderer/components";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ClockIcon,
  AlertFillIcon,
  ImageIcon,
  CheckCircleFillIcon,
} from "@primer/octicons-react";
import {
  EMULATOR_ICONS,
  RETROARCH_EMULATOR_ICON,
} from "@renderer/pages/settings/emulation/emulator-icons";
import "./library-game-card.scss";
import { logger } from "@renderer/logger";

interface LibraryGameCardProps {
  game: LibraryGame;
  onContextMenu: (
    game: LibraryGame,
    position: { x: number; y: number }
  ) => void;
  onShowTooltip?: (gameId: string) => void;
  onHideTooltip?: () => void;
  // Grid view's cells are large enough that the small iconUrl fallback (the
  // only image many custom/picker-added games have) gets stretched into a
  // blurry mess -- skip it there and fall back to the placeholder instead.
  // Compact view's cells are small enough that the same icon looks fine.
  preferCoverOnly?: boolean;
}

export const LibraryGameCard = memo(function LibraryGameCard({
  game,
  onContextMenu,
  preferCoverOnly = false,
}: Readonly<LibraryGameCardProps>) {
  const { t } = useTranslation("library");
  const { formatPlayTime, handleCardClick, handleContextMenuClick } =
    useGameCard(game, onContextMenu);

  const isInstalled = Boolean(game.executablePath);
  const customGameBadgeKind = getCustomGameBadgeKind(game);

  const hasPickedCover = Boolean(game.selectedArtworkTypes?.includes("grid"));

  const orderedCandidates = [
    { url: game.customCoverImageUrl, isChosenCover: true }, // Level 0
    { url: game.coverImageUrl, isChosenCover: hasPickedCover }, // Level 1
    { url: game.libraryImageUrl, isChosenCover: false }, // Level 2
    ...(preferCoverOnly ? [] : [{ url: game.iconUrl, isChosenCover: false }]), // Level 3
  ].filter(({ url }) => url && url.trim() !== "");

  // Animated covers should autoplay by default -- try any animated-format
  // candidate before falling back through the normal static priority order,
  // instead of only ever using whichever tier happens to come first.
  const candidates = [
    ...orderedCandidates.filter((candidate) =>
      isAnimatedCoverCandidate(candidate.url)
    ),
    ...orderedCandidates.filter(
      (candidate) => !isAnimatedCoverCandidate(candidate.url)
    ),
  ];

  const sources = candidates.map(({ url }) => url);

  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [imageError, setImageError] = useState(false);

  const resolveImageSource = (imageUrl: string | null | undefined): string => {
    if (!imageUrl) return "";

    const trimmedImageUrl = imageUrl.trim();
    if (!trimmedImageUrl) return "";

    if (
      trimmedImageUrl.startsWith("http://") ||
      trimmedImageUrl.startsWith("https://") ||
      trimmedImageUrl.startsWith("data:") ||
      trimmedImageUrl.startsWith("blob:")
    ) {
      return trimmedImageUrl;
    }

    if (trimmedImageUrl.startsWith("local:")) {
      const normalizedLocalPath = trimmedImageUrl
        .slice("local:".length)
        .replaceAll("\\", "/");
      return `local:${normalizedLocalPath}`;
    }

    const normalizedPath = trimmedImageUrl.replaceAll("\\", "/");
    if (/^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("/")) {
      return `local:${normalizedPath}`;
    }

    return normalizedPath;
  };

  const activeImageSource = resolveImageSource(sources[fallbackIndex]);
  const isChosenCoverActive = Boolean(candidates[fallbackIndex]?.isChosenCover);

  const { label: classicsPlatformLabel, icon: classicsEmulatorIcon } =
    resolveClassicsBadge(
      game.shop,
      game.platform,
      CLASSICS_PS_PLATFORM_LABELS,
      {
        emulatorIcons: EMULATOR_ICONS,
        retroarchIcon: RETROARCH_EMULATOR_ICON,
      }
    );

  const handleImageError = () => {
    logger.warn(`Image failed to load for ${game.title}`, {
      failedUrl: sources[fallbackIndex],
      level: fallbackIndex,
    });

    if (fallbackIndex < sources.length - 1) {
      setFallbackIndex((prevIndex) => prevIndex + 1);
    } else {
      setImageError(true);
    }
  };

  useEffect(() => {
    setFallbackIndex(0);
    setImageError(false);
  }, [
    game.id,
    game.customCoverImageUrl,
    game.coverImageUrl,
    game.libraryImageUrl,
    game.iconUrl,
    preferCoverOnly,
  ]);

  const renderCoverMedia = () => {
    if (imageError || !activeImageSource) {
      return (
        <div className="library-game-card__cover-placeholder">
          <ImageIcon size={48} />
        </div>
      );
    }

    if (game.shop === "launchbox" && !isChosenCoverActive) {
      return (
        <div className="library-game-card__classics-cover">
          <img
            src={activeImageSource}
            alt=""
            aria-hidden="true"
            className="library-game-card__classics-backdrop"
            loading="lazy"
            onError={handleImageError}
          />
          <img
            src={activeImageSource}
            alt={game.title}
            className="library-game-card__classics-image"
            loading="lazy"
            onError={handleImageError}
          />
        </div>
      );
    }

    return (
      <img
        src={activeImageSource}
        alt={game.title}
        className={`library-game-card__game-image ${
          isChosenCoverActive ? "library-game-card__game-image--contain" : ""
        }`}
        loading="lazy"
        onError={handleImageError}
      />
    );
  };

  return (
    <button
      type="button"
      className="library-game-card__wrapper"
      title={game.title}
      onClick={handleCardClick}
      onContextMenu={handleContextMenuClick}
    >
      <div
        className={`library-game-card__overlay${game.shop === "launchbox" && !isChosenCoverActive ? " library-game-card__overlay--classics" : ""}${(game.achievementCount ?? 0) > 0 ? "" : " library-game-card__overlay--no-fade"}`}
      >
        <div className="library-game-card__top-section">
          <div className="library-game-card__playtime">
            {game.hasManuallyUpdatedPlaytime ? (
              <AlertFillIcon
                size={11}
                className="library-game-card__manual-playtime"
              />
            ) : (
              <ClockIcon size={11} />
            )}
            <span className="library-game-card__playtime-long">
              {formatPlayTime(game.playTimeInMilliseconds)}
            </span>
            <span className="library-game-card__playtime-short">
              {formatPlayTime(game.playTimeInMilliseconds, true)}
            </span>
          </div>

          {classicsPlatformLabel && (
            <div className="library-game-card__classics-badges">
              <span className="library-game-card__platform-badge">
                {classicsPlatformLabel}
              </span>
              {classicsEmulatorIcon && (
                <span className="library-game-card__emulator-badge">
                  <img src={classicsEmulatorIcon} alt="" />
                </span>
              )}
            </div>
          )}

          {customGameBadgeKind && (
            <div
              className="library-game-card__custom-badge"
              title={t(`${customGameBadgeKind}_game_badge_tooltip`)}
            >
              <span className="library-game-card__custom-text">
                {t(`${customGameBadgeKind}_game_badge`)}
              </span>
            </div>
          )}

          {isInstalled && (
            <div
              className="library-game-card__installed-badge"
              title={t("installed_tooltip")}
            >
              <CheckCircleFillIcon
                size={11}
                className="library-game-card__installed-icon"
              />
              <span className="library-game-card__installed-text">
                {t("installed")}
              </span>
            </div>
          )}
        </div>

        {(game.achievementCount ?? 0) > 0 && (
          <AchievementProgress
            achievementCount={game.achievementCount ?? 0}
            unlockedAchievementCount={game.unlockedAchievementCount ?? 0}
            classNamePrefix="library-game-card"
            label={`${game.title} achievements`}
            hidePercentage
          />
        )}
      </div>

      {renderCoverMedia()}
    </button>
  );
});
