# Hydra fork — working notes for Claude

This is a personal fork of [Hydra Launcher](https://github.com/hydralauncher/hydra)
(Electron/TS game download client). `main` on this fork is the personal
working branch — custom features accumulate here directly, often
uncommitted for stretches while testing. Clean single-purpose PR branches
for upstream contribution are built separately via `git worktree add`, off
`origin/main`, one feature per branch — don't build upstream PR work
directly on `main`.

## Remotes

- `origin` → `hydralauncher/hydra` (upstream, read from for rebases/PRs)
- `fork` → `t0mbi/hydra` (this fork, push here — **public repo**)

## Architecture quick reference

- Main process: `src/main`. IPC handlers use `registerEvent(name, handler)`
  (see `src/main/events/**`), exposed to the renderer via `src/preload/index.ts`.
- Storage: LevelDB via sublevels in `src/main/level` (`gamesSublevel`,
  `downloadsSublevel`, `gamesShopAssetsSublevel`, `gamesArtworkSelectionSublevel`, etc.),
  keyed by `levelKeys.game(shop, objectId)`.
- Renderer: `src/renderer/src`, React + contexts/hooks per page.
- A separate "Big Picture" mode UI lives in `src/big-picture` and largely
  mirrors renderer patterns/pages independently — changes to shared
  behavior (e.g. library data, download state) often need updating in both.

## Custom features built in this fork (not upstream)

- **Custom (non-Steam) games**: add via drag-and-drop or manual path, with
  Steam matching (`use-steam-match-search.ts`, `matchedSteamObjectId` on the
  `Game` record) to pull real Steam artwork/known-executable-name tracking
  for playtime/achievements/cloud-save. See `add-custom-game-to-library.ts`,
  `update-custom-game.ts`, `check-steam-shortcut.ts`.
- **SteamGridDB personal API key** (`settings-steamgriddb.tsx`,
  `authenticate-steam-grid-db.ts`, `steam-grid-db-direct.ts`): lets the user
  supply their own SteamGridDB key as a fallback artwork source. **This was
  proposed upstream and declined** by the maintainer over API-abuse concerns
  — it stays fork-only, don't re-propose without a materially different
  design.
- **Installer-exit executable detection** (`open-game-installer.ts`,
  `rescanAndBindExecutableAfterInstall`): installer-based repacks (FitGirl,
  DODI, etc.) weren't recognized as installed because the only auto-detect
  scan ran once at extraction time, before the installer placed files. Now
  rescans plausible install locations after the installer process exits.
  Paired with a Downloads-page fix (`get-game-installer-action-type.ts`) so
  the "Install" button doesn't show forever once a game's `executablePath`
  is set.
- **Steam shortcut artwork fallback for custom games** (`create-steam-shortcut.ts`,
  `resolveShortcutAssetUrls`): custom-shop games got no hero/logo/icon on
  their Steam shortcut, only a cover — `getGameAssets()` always returns
  `null` for `shop === "custom"`, and the resolver only checked the
  cross-device custom-upload override fields, not the game's own
  `iconUrl`/`logoImageUrl`/`libraryHeroImageUrl` (populated at add/match
  time from the matched Steam title). Fixed by falling back to those fields.

## Abandoned — don't re-attempt without new information

- **Windows UAC elevation retry for installer/game launches requiring admin
  rights.** Tried: `Start-Process -Verb RunAs` (exits too fast, missing
  `-Wait`), then with `-Wait` (still broken — `[`/`]` in folder names like
  `"Cuphead [FitGirl Repack]"` are wildcards to `Start-Process`'s path
  params), then `System.Diagnostics.Process`/`ProcessStartInfo` directly
  with `Verb='runas'` (conflicts with some installers' own bootstrap
  elevation logic), then relying on `UseShellExecute=true` + the exe's own
  manifest for auto-elevation (worked when the PowerShell script was run
  directly, but never reliably triggered UAC when invoked through Hydra's
  actual `child_process.spawn()` call chain — root cause never conclusively
  found). Current behavior is back to original upstream behavior: `EACCES`
  on spawn just logs and, for installers, falls through to
  `shell.openPath()` (double-click equivalent, which does reliably trigger
  UAC when done manually).

## Local-only files — never commit

- `test steamgrid api key.txt` — a raw SteamGridDB API key, kept local
  intentionally (repo is public). Re-enter it via Settings → SteamGridDB on
  each machine instead of syncing the file.
- `hydralauncher-*-portable/` — built Electron output, ~900MB+, platform-specific
  and regenerable (`yarn build`/`yarn dist`). Never belongs in git.
- Misc local scratch (`*.lnk` shortcuts, `dev.bat`, `monitor-processes.ps1`,
  `process-monitor.csv`) — personal debug artifacts, Windows-specific, skip
  when committing.

## Parked / not yet built

- Local/network-folder (e.g. Unraid share) save backup that bypasses
  Hydra's account-gated cloud saves — reuses `Ludusavi.backupGame` and the
  existing `restoreLudusaviBackup` helper, writes to/reads from a plain
  configured folder instead of Hydra's API. Design was scoped in a prior
  session but not implemented.
- A separate cross-platform save-sync tool ("nimbus",
  `github.com/t0mbi/nimbus`) was spun off as its own project — unrelated to
  this repo, don't conflate the two.
