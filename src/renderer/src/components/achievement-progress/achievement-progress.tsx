import { TrophyIcon } from "@primer/octicons-react";
import { isGameCompleted } from "@renderer/helpers";
import { ProgressBar } from "../progress-bar/progress-bar";

interface AchievementProgressProps {
  achievementCount: number;
  unlockedAchievementCount: number;
  classNamePrefix: string;
  label: string;
  trophyIconSize?: number;
  hidePercentage?: boolean;
}

export function AchievementProgress({
  achievementCount,
  unlockedAchievementCount,
  classNamePrefix,
  label,
  trophyIconSize = 13,
  hidePercentage = false,
}: Readonly<AchievementProgressProps>) {
  const isCompleted = isGameCompleted(
    achievementCount,
    unlockedAchievementCount
  );
  const safeMax = achievementCount || 1;
  const percentage = Math.round((unlockedAchievementCount / safeMax) * 100);

  const percentageClassName = `${classNamePrefix}__achievement-percentage`;
  const completedClassName = `${percentageClassName}--completed`;
  const className = isCompleted
    ? `${percentageClassName} ${completedClassName}`
    : percentageClassName;

  return (
    <div className={`${classNamePrefix}__achievements`}>
      <div className={`${classNamePrefix}__achievement-header`}>
        <div className={`${classNamePrefix}__achievements-gap`}>
          {!isCompleted && (
            <TrophyIcon
              size={trophyIconSize}
              className={`${classNamePrefix}__achievement-trophy`}
            />
          )}
          <span className={`${classNamePrefix}__achievement-count`}>
            {unlockedAchievementCount} / {achievementCount}
          </span>
        </div>
        {(!hidePercentage || isCompleted) && (
          <span className={className}>
            {isCompleted ? (
              <TrophyIcon size={trophyIconSize} />
            ) : (
              <>{percentage}%</>
            )}
          </span>
        )}
      </div>
      <ProgressBar
        now={unlockedAchievementCount}
        max={safeMax}
        label={label}
        completed={isCompleted}
        trackClassName={`${classNamePrefix}__achievement-progress`}
        barClassName={`${classNamePrefix}__achievement-bar`}
      />
    </div>
  );
}
