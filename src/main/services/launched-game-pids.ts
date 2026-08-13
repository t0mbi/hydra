export const launchedGamePids = new Map<string, number>();

// Steam/Epic protocol launches (steam://rungameid, com.epicgames.launcher://)
// don't hand back a PID the way spawn() or the UWP COM activation call do --
// process-watcher.ts has to discover the real process by scanning for one
// under the game's install folder. This records when that scan should start
// (gameKey -> the time the protocol launch was triggered) and lets it give
// up after a while if the game never actually starts (user cancelled it,
// closed the external launcher's own prompt, etc).
export const pendingExternalLaunches = new Map<string, number>();
