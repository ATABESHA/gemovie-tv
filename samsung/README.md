# MyMovie for Samsung TVs

The same app as on the Android TV (same screens, profiles, Continue watching, My List, search,
Georgian / Russian / English), packaged as a Samsung **Tizen** web app. Made for a 2017
**UE55MU6255** (Tizen 3.0); newer Samsung TVs run it too.

| File | What it is |
|---|---|
| `tizen.js` | What the Android app's Java code does: remote control, Back/exit, translations, trailers, and the video player |
| `config.xml` | The app's settings (name, id `MyMovieTV1.MyMovie`, permissions) |
| `icon.png`, `fonts/` | App icon; Noto Sans Georgian (SIL Open Font License), because 2017 TVs sold outside Georgia have no Georgian letters |
| `../tools/samsung/build.js` | Builds `samsung/build/` from `app/src/main/assets/tvui.html` + the files above |
| `../tools/samsung/preview.js` | Shows the build in a PC browser (layout, site pages, player) |

## How it differs from Android

- **The 2017 TV's browser engine is old (about Chrome 47).** The build rewrites the
  screens' newer styling (CSS variables, `gap`, `inset`, grid) into what it understands, and
  stops with an error if anything newer is left.
- **The video player** is the site's own player (Playerjs). Samsung apps can't put a script
  inside it, so the app drives it through the player's message interface (`{api:"play"}`,
  `{api:"seek",set:…}`) and reads its time reports for Continue watching.
  Remote: **OK / Play-Pause** = play/pause, **Left/Right** = 10 s (hold for 60 s),
  **⏪ ⏩** = 60 s, **Back** = close. The player's own menus (audio, subtitles, episodes) can't be reached
  with the remote.
- **Trailers** (YouTube) play, but only Back works on them.
- **Updates** aren't automatic: install the new version from the PC (below).
- **Cloudflare:** if gemovie.tv turns on its "checking your browser" page, this TV's engine
  can't pass it; the app says so. Right now the site doesn't use it.
- If the site moves again, the app follows its redirect by itself.

## Build

```bash
node tools/samsung/build.js
```

To look at it on the PC first: `node tools/samsung/preview.js`, then open http://localhost:8790/
(arrows, Enter, Backspace = Back).

## Put it on the TV (once, with the PC on the same network as the TV)

1. **Developer mode on the TV:** open **Apps**, type **1 2 3 4 5** on the remote, switch
   **Developer mode** on, enter the PC's IP address, then turn the TV off and on.
2. **Connect:** `sdb connect <TV-IP>` (sdb is in Tizen Studio's `tools` folder). The TV shows
   up in `sdb devices`.
3. **Certificate for this TV:** Samsung only installs apps signed for that exact TV. In VS
   Code's Tizen extension (or Tizen Studio) open **Certificate Manager**, create a **Samsung**
   certificate profile while the TV is connected (it reads the TV's ID), and sign in with
   the Samsung account when asked.
4. **Package and install** (replace `MyTV` with the profile name from step 3):

   ```bash
   tizen package -t wgt -s MyTV -- samsung/build
   tizen install -n MyMovie.wgt -t <TV name from sdb devices> -- samsung/build
   ```

   MyMovie then appears in the TV's Apps. Developer mode can stay on; the app keeps working
   after it is switched off.

New version later: build, package and install again the same way (step 4).
