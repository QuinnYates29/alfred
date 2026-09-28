# Alfred for macOS

A menu-bar app for alfred. Everything runs on the Spark; the app opens the dashboard in its own window,
shows notifications you can act on (Approve / Deny), has a quick-add box, and can optionally run the
`alfred-node` so this Mac is a workspace.

## Build (on the Spark or the Mac)

```bash
npm --prefix app run pack:mac      # → app/dist/Alfred-mac-arm64.zip  (Alfred.app + install-mac.sh)
```

`pack:mac` bundles the node (`app/node/alfred-node.mjs`) and the CLI, builds an icon, packages Alfred.app for
darwin-arm64 with @electron/packager (it downloads the Electron darwin build once) and zips it. It also writes
`app/build.json` (bundled: what the app reports as its version) and `app/dist/latest.json`
(`{ version, build, sha256, size, builtAt, commit }`), which the Spark serves to the app for updates. The app is
**unsigned**.

On the Spark you can also build from the dashboard: **System → Builds → Build Mac app**
(`POST /api/v1/ops/app/build`). An agent's `alfred_dev deploy` rebuilds it automatically when the merged change
touched `app/`, `src/node/` or `src/cli*`.

## Install on the Mac

1. Copy `Alfred-mac-arm64.zip` to the Mac (e.g. `scp spark:repos/alfred/app/dist/Alfred-mac-arm64.zip ~/Downloads/`)
   and double-click it to unzip.
2. Recommended: in Terminal, `bash ~/Downloads/install-mac.sh`. It moves Alfred.app to /Applications, clears the
   quarantine flag (`xattr -cr`), ad-hoc signs it (`codesign --force --deep --sign -`) and opens it.
3. By hand instead: drag **Alfred.app** into **Applications**, then run
   `xattr -cr /Applications/Alfred.app && codesign --force --deep --sign - /Applications/Alfred.app`
   (Apple Silicon refuses to start an app whose signature was invalidated by packaging; this re-signs it).
   The first time, **right-click Alfred → Open** and confirm, because the app is not notarized. After that it
   opens normally. (If macOS says it "is damaged", the codesign step was skipped.)

You only do this once. After that, updates come from the app itself (below).

## Updates (from inside the app)

Settings → **Updates** shows this app's version/build/commit and the newest build on the Spark.

- **Check now** asks the Spark (`GET /api/v1/app/latest`). With *Check automatically* on (default), the app also
  checks on launch and every 6 hours; when there is a newer build, the menu bar menu shows **Update available —
  install** and a notification appears.
- **Update now** downloads the zip from your configured server with your token, **verifies its sha256** against
  `latest.json` (a mismatch is refused and nothing is unpacked), unpacks it with `ditto`, checks the new bundle's
  identifier, then quits. A small helper swaps the bundles: the current one becomes `Alfred.app.previous`, the new
  one goes in its place, gets `xattr -cr` + an ad-hoc `codesign`, and is reopened. If any step fails the old
  bundle is put back. The helper's log is `update.log` next to `settings.json`.
- **Roll back to previous version** (shown when `Alfred.app.previous` exists) swaps the two back the same way.

Your settings and token live in `~/Library/Application Support/Alfred/`, which an update doesn't touch. Because
each build is signed ad hoc, macOS may ask once after an update whether Alfred may use "Alfred Safe Storage" in
the keychain: click **Always Allow**. If the keychain refuses, Settings opens with a note asking you to paste the
token again (it doesn't fail silently).

## First run

Settings opens on its own when no URL/token is saved:

- **URL**: `https://gx10-de9a.tail542084.ts.net:8443` (the tailnet URL; Tailscale must be connected).
- **Token**: the value of `ALFRED_TOKEN` from the Spark's `~/.config/alfred.env`.
- Click **Test connection**, then **Save**. The dashboard window opens and the menu-bar icon goes live.

Settings also has **Install command-line tool…**: it copies `alfred` to `~/.local/bin` and writes
`~/.config/alfred/cli.json` (mode 0600) with this app's URL and token, so the CLI needs no `alfred login`.

The token is kept in the macOS keychain (Electron safeStorage; the settings file only holds the encrypted
blob). On other platforms it's stored in `settings.json` with mode 0600. Settings live in
`~/Library/Application Support/Alfred/settings.json`.
macOS may ask once to allow "Alfred Safe Storage" keychain access: choose **Always Allow**.

## Using it

- **Menu bar**: live/offline, running and parked counts, GPU/Qwen load, Inbox, Approvals (Approve/Deny from
  the menu), Needs attention, Pause notifications (1 h), Settings…, Quit. The number next to the icon is how
  many things need you; `!` means offline.
- **Window**: the full dashboard. Closing it keeps Alfred in the menu bar; ⌘Q quits. Links to other sites
  open in your browser.
- Shortcuts: ⌘O open, ⌘N new goal, ⇧⌘N new item, ⌘I inbox, ⌘, settings.
- **Notifications**: failures/stops/blocked tasks, "Needs Claude", approvals (with Approve / Deny buttons —
  set Alfred's notification style to *Alerts* in System Settings → Notifications so the buttons stay visible),
  finished goals (off by default) and chat replies while the window is in the background. Clicking one opens
  the relevant page.

### Quick add (⇧⌘Space by default, or menu bar → Quick add…)

| You type | What happens |
| --- | --- |
| `Renew passport #home !! @2026-10-02` | board item, labels `home`, priority high, due date |
| `pay rent !!! @tomorrow` | item, priority urgent, due tomorrow (`@today` works too) |
| `! research standing desks` | starts a goal (persona alfred) |
| `? what is running` | asks Alfred; the reply shows under the box |

Enter submits, Esc closes. The shortcut is configurable in Settings.

## This Mac as a workspace (optional)

Settings → *This Mac as a workspace*: tick **Run the node**, give it a name (default `macbook`) and one or
more root folders (only those are reachable), optionally allow desktop shell. Save. The app runs the bundled
node with its own binary (`ELECTRON_RUN_AS_NODE=1`), so it needs no Node, npx or PATH on the Mac, and restarts
it if it exits. The menu shows `Node: macbook running`. Its log is `node.log` next to `settings.json`.
If the LaunchAgent from `deploy/node-install-macos.sh` is still installed, Settings shows **Use the app's
built-in node instead of the LaunchAgent**: it runs `launchctl unload` on `~/Library/LaunchAgents/com.alfred.node.plist`,
renames it to `com.alfred.node.plist.disabled`, and turns the built-in node on with the agent's name/roots/flags.
Running both makes two nodes with the same name keep replacing each other (flapping). To undo, rename the plist back and
`launchctl load` it.

## Troubleshooting

- **Offline / `!` in the menu bar**: is Tailscale up? Try Settings → Test connection. `unauthorized` = wrong token.
- **Settings reopen asking for the token after an update**: the re-signed app couldn't read the old keychain
  item; paste the token again, and choose **Always Allow** on the keychain prompt.
- **Update failed**: the message says why (sha mismatch, no build on the server, …). See `update.log` in
  `~/Library/Application Support/Alfred/`. If the new version misbehaves, Settings → Updates → Roll back, or by hand:
  quit Alfred, `mv /Applications/Alfred.app /tmp/ && mv /Applications/Alfred.app.previous /Applications/Alfred.app`.
- **No notifications**: System Settings → Notifications → Alfred → allow; check *Pause notifications* is off.
- **Install command-line tool…** says the CLI is not bundled: this build has no `app/cli/alfred.mjs`
  (produced by the repo's `npm run build:cli`); rebuild after adding it.
- Run from source for debugging: `npm --prefix app start` (on the Mac, with Electron installed in app/).
