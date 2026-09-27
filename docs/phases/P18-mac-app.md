# P18 — Alfred for macOS (native app: menubar + window + notifications + quick add + optional node)

Status: **SPEC** · Branch: `p18-app` · Acceptance: `npx vitest run test/acceptance/p18/`
Scope (files you own): `app/**` (Electron; its own package.json — electron and @electron/packager are already installed in `app/node_modules`),
plus `test/unit/app*.test.ts`. Do NOT edit server code, `web/**` except as noted in §7, or `test/acceptance/**`.

All compute stays on the Spark. The app is Quinn's primary client on the Mac: it lives in the menu bar, raises native notifications
he can act on, opens the full dashboard in a real window, and can optionally run the `alfred-node` so the Mac is a workspace.
Plain JavaScript (CommonJS `.cjs` for the main process, no bundler, no TypeScript, no new dependencies besides what is in `app/package.json`).

## 1. Layout
```
app/src/main.cjs        app lifecycle, windows, tray, IPC, wiring
app/src/settings.cjs    load/save settings (token encrypted with safeStorage when available)
app/src/api.cjs         tiny client: request(method, path, body) with Bearer token; stream(path, onEvent) = SSE over fetch with reconnect
app/src/notify.cjs      event → notification decisions (pure function, unit-testable) + showing them
app/src/tray.cjs        tray icon/title/menu built from a state object (pure menu template builder + a thin Tray wrapper)
app/src/quick.cjs       quick-add parsing (pure) + submit
app/src/node.cjs        optional embedded alfred-node child process (spawn/restart/stop)
app/src/preload.cjs     contextBridge: window.alfredNative = { version, isApp: true, quickSubmit(text), getSettings(), saveSettings(s), testConnection(s) }
app/src/settings.html   settings/onboarding window (URL, token, notifications toggles, launch at login, node section) — self-contained HTML+JS using preload
app/src/quick.html      quick-add window (one input, hint line, result line)
app/assets/             trayTemplate.png (16x16 + @2x, black on transparent), icon.png (512), icon.icns (optional; pack script may generate from png via sips on macOS)
app/scripts/build-node.mjs   esbuild src/node/client.ts + bin entry → app/node/alfred-node.mjs (single file, deps bundled)
app/scripts/pack-mac.mjs     @electron/packager for darwin arm64 → app/dist/Alfred-darwin-arm64/Alfred.app, then zip → app/dist/Alfred-mac-arm64.zip
app/install-mac.sh      run on the Mac: unzip to /Applications, `xattr -cr`, `codesign --force --deep --sign -` (ad-hoc), open it
```

## 2. Settings (`settings.cjs`)
Directory: `process.env.ALFRED_APP_CONFIG_DIR` or `app.getPath('userData')`; file `settings.json`:
`{ url: string, token: string, notify: { failures: true, approvals: true, done: false, chat: true }, launchAtLogin: false, shortcut: 'CommandOrControl+Shift+Space',
   node: { enabled: false, name: 'macbook', roots: [] as string[], dsh: false } }`.
The token is stored as `tokenEnc` (base64 of `safeStorage.encryptString`) when `safeStorage.isEncryptionAvailable()`, else plain `token`.
`load()` returns defaults merged with the file (a missing/corrupt file → defaults). Default url: `https://gx10-de9a.tail542084.ts.net:8443`.

## 3. Windows
- **Main window** (1280×820, remembers bounds in settings, `titleBarStyle: 'hiddenInset'` on macOS, min 900×600): loads `<url>/?token=<token>#/`.
  Navigation to another origin → opened in the default browser (`shell.openExternal`), never inside the app. Closing the window hides it
  (the app keeps running in the menu bar); ⌘Q quits.
- **Settings window**: shown on first run (no url or token) and from the tray. "Test connection" calls `GET /api/v1/health` with the typed
  values and shows ok/error; Save persists, reloads the main window and reconnects the event stream.
- **Quick add** (global shortcut from settings, also tray "Quick add…"): a small frameless always-on-top window centred on screen with one input.
  Enter submits via IPC, shows the result line for 1.2 s, then hides. Escape hides.

## 4. Quick add grammar (`quick.cjs`, pure `parseQuick(text)`)
- `! <text>` → `{ kind: 'goal', title: <text> }` → `POST /api/v1/goals { title, persona: 'alfred', spec: text }`
- `? <text>` → `{ kind: 'ask', text }` → `POST /api/v1/chat { text }` → result line = the reply (first 200 chars)
- otherwise → `{ kind: 'item', title, due?, priority?, labels? }` → `POST /api/v1/items`. Inline tokens are removed from the title:
  `#label` (repeatable) → labels; `!!` → priority high, `!!!` → urgent; `@today` / `@tomorrow` / `@YYYY-MM-DD` → due (local date).
- Empty → `{ kind: 'none' }`. Result line: `Created ALF-12`, `Started goal <slug>`, or the reply; errors → `⚠ <message>`.

## 5. Event stream → notifications (`notify.cjs`)
The main process keeps one SSE connection to `/api/v1/events?since=<last>` (start from `GET /api/v1/events/last`; reconnect with backoff
1 → 30 s; parse `id:` / `data:` frames). A pure function decides:
`decide(ev, ctx) → null | { title, body, url /* hash route */, actions?: ['Approve','Deny'], approvalId?, kind }` with
`ctx = { settings, goalTitle(goalId), taskTitle(taskId) }`:
- `transition` to `failed`/`stopped`/`blocked` (settings.notify.failures) → title `Failed: <task title>` / `Stopped: …` / `Blocked: …`, body = reason, url `/goal/<goalId>`.
- `transition` to `needs_claude` → `Needs Claude: <task title>`.
- `approval_requested` (notify.approvals) → title `Approval needed: <action>`, body = detail, actions `['Approve','Deny']`, approvalId, url `/inbox`.
- `goal_status` `done` (notify.done) → `Done: <goal title>`; `failed` → `Goal failed: <goal title>` (failures).
- `chat_message` with `message.role === 'assistant'` (notify.chat) and the main window not focused → `alfred`, body = content (≤ 180 chars), url `/chat/<threadId>`.
- anything else → null. Titles/bodies never exceed 200 chars.
Showing: Electron `Notification` (`actions` as buttons on macOS). Click → show main window at `url`. Action Approve/Deny →
`POST /api/v1/approvals/<id> { decision: 'approved'|'denied', by: 'mac-app' }`.
**Test mode:** when `ALFRED_APP_TEST=1`, notifications are not shown; each decided notification is appended as one JSON line to
`<configDir>/notifications.log`, and IPC `test:notificationAction(approvalId, action)` runs the same action handler.

## 6. Tray (`tray.cjs`)
State polled every 15 s (and after relevant events): `GET /api/v1/goals`, `/api/v1/approvals?status=pending`, `/api/v1/stats` (tolerate 404).
`buildMenu(state) → Electron menu template` (pure; tested):
- first line (disabled): `● Live` / `○ Offline` + `· <running> running · <parked> parked`
- `GPU <util>% · Qwen <busy>/<total>` (disabled) when stats are available
- `Open Alfred` (⌘O) · `Quick add…` · `New goal…` (opens main window at `#/?new=goal`) · `Inbox (<n>)`
- `Approvals` submenu when pending: per approval `<action>: <detail ≤ 50>` → submenu `Approve` / `Deny`
- `Needs attention` submenu: failed goals / parked tasks → open that goal
- separator · `Pause notifications` (checkbox; 1 h) · `Settings…` · `Install command-line tool…` · `Quit Alfred`
Tray title (macOS menu bar text next to the icon) = the attention count when > 0, else empty. Offline → the icon dims (use the same image; title `!`).

## 7. Integration with the website
- The web app may call `window.alfredNative?.…` but must work without it. `#/?new=goal` / `#/?new=item` already open those dialogs
  (App.jsx). Do not edit `web/**`.
- `Install command-line tool…`: copies the bundled CLI (`app/cli/alfred.mjs`, produced by the root `npm run build:cli` — if it's missing,
  say so) to `~/.local/bin/alfred` (chmod 755) and writes `~/.config/alfred/cli.json` with the app's url + token (mode 600).

## 8. Embedded node (`node.cjs`)
When `settings.node.enabled`: spawn `process.execPath` with env `ELECTRON_RUN_AS_NODE=1` and args
`[<app>/node/alfred-node.mjs, '--server', <ws(s) url derived from settings.url>, '--token', <token>, '--name', name, ...roots.flatMap(r => ['--root', r]), ...(dsh ? ['--dsh'] : [])]`;
restart on exit with backoff; stop on quit or when disabled. Tray shows `Node: <name> running|stopped`. `build-node.mjs` bundles it with esbuild
(from the repo's node_modules) — the bundle must run with plain node.

## 9. Packaging
`npm --prefix app run pack:mac` → `app/dist/Alfred-mac-arm64.zip` (unsigned; works from Linux with @electron/packager). `app/README.md`:
install (`install-mac.sh`), first-run settings, the quick-add grammar, shortcuts, how to enable the node, and troubleshooting.

## IPC contract (registered with `ipcMain.handle`; the test calls these handlers directly)
- `quick:submit(text) → string` — parse + submit, returns the result line (`Created ALF-3`, `Started goal <slug>`, reply, or `⚠ …`).
- `settings:get() → settings (token included)`, `settings:save(s) → {ok}`, `settings:test(s) → {ok, error?}`.
- `test:notificationAction(approvalId, 'Approve'|'Deny') → void` (only when `ALFRED_APP_TEST=1`).
- `test:trayMenu() → the current menu template` (only in test mode; the state it was built from must be refreshed at least every 15 s and right after start).
Module exports used by the tests: `quick.cjs` → `parseQuick`; `notify.cjs` → `decide(ev, ctx)` where `ctx.windowFocused` is a boolean;
`tray.cjs` → `buildMenu(state)` with `state = { live, running, parked, attention, stats, approvals, attentionGoals, paused, node }`
(returns a plain array of `{label, enabled?, type?, submenu?, click?}`; JSON-serializable apart from `click`).

## Acceptance (`test/acceptance/p18/app.test.ts`)
Pure modules via `require` (parseQuick, decide, buildMenu, settings load/save round-trip incl. corrupt file), then an end-to-end run:
a real `startAlfred` (scripted LLM, token set), the app launched with Playwright's `_electron` under Xvfb (`ALFRED_APP_TEST=1`,
`ALFRED_APP_CONFIG_DIR` pre-seeded with url + token): the main window shows the dashboard (the sidebar text `Board`); a failing task produces a
`Failed: …` line in notifications.log within 5 s; an approval produces a notification with actions and `test:notificationAction` approves it;
the quick-add IPC creates a board item and a goal; the tray menu template contains `Open Alfred` and the running count.
