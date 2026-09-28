# Alfred for macOS

A menu-bar app for alfred. Everything runs on the Spark; the app opens the dashboard in its own window,
shows notifications you can act on (Approve / Deny), has a quick-add box, and can optionally run the
`alfred-node` so this Mac is a workspace.

## Build (on the Spark or the Mac)

```bash
npm --prefix app run pack:mac      # → app/dist/Alfred-mac-arm64.zip  (Alfred.app + install-mac.sh)
```

`pack:mac` bundles the node (`app/node/alfred-node.mjs`), builds an icon, packages Alfred.app for
darwin-arm64 with @electron/packager (it downloads the Electron darwin build once) and zips it. The app is
**unsigned**.

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

## First run

Settings opens on its own when no URL/token is saved:

- **URL**: `https://gx10-de9a.tail542084.ts.net:8443` (the tailnet URL; Tailscale must be connected).
- **Token**: the value of `ALFRED_TOKEN` from the Spark's `~/.config/alfred.env`.
- Click **Test connection**, then **Save**. The dashboard window opens and the menu-bar icon goes live.

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
If you used the LaunchAgent from `deploy/node-install-macos.sh` before, unload it so the Mac doesn't connect twice.

## Troubleshooting

- **Offline / `!` in the menu bar**: is Tailscale up? Try Settings → Test connection. `unauthorized` = wrong token.
- **Settings reopen asking for the token after an update**: the re-signed app can't read the old keychain
  item; paste the token again.
- **No notifications**: System Settings → Notifications → Alfred → allow; check *Pause notifications* is off.
- **Install command-line tool…** says the CLI is not bundled: this build has no `app/cli/alfred.mjs`
  (produced by the repo's `npm run build:cli`); rebuild after adding it.
- Run from source for debugging: `npm --prefix app start` (on the Mac, with Electron installed in app/).
