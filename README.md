# GE Movie TV

An Android TV app that opens **ge.movie** full screen and lets you use it with the
TV remote, Netflix-style: no mouse pointer, a red highlight moves between items.

Made for Sony Bravia 4K UR2 (Android TV 10), works on any Android TV / Google TV.

## Remote controls

| Button | While browsing | While a video is full screen |
|---|---|---|
| Arrows | Move the highlight (rows scroll by themselves) | ◀ ▶ seek 10 s; ▲ or ▼ shows the player controls |
| OK | Open / press the highlighted item | Play / pause |
| Back | Close menu or keyboard, then previous page; press twice on the home page to exit | Leave full screen |

**Player controls in full screen** (quality, audio, subtitles, settings): press ▲ or ▼.
The player's control bar appears with a red highlight; move with the arrows and press OK
to open a menu or choose an option. Back (or 10 s without pressing anything) returns to
normal playback; Back again leaves full screen.

## Test builds vs TV releases

- **Every push to `main`** builds a **test** APK only:
  `https://github.com/ATABESHA/gemovie-tv/releases/download/test/gemovie-tv-test.apk`.
  The TV never sees it.
- **To send a version to the TV**, push a tag named `tv-…` (e.g. `tv-5`), or open
  Actions → Build APK → Run workflow and tick **Publish to TV**. The TV app then offers
  the update.

### Testing on the PC with BlueStacks

1. Download the test APK above and drag it onto the BlueStacks window (or use
   *Install APK* in the side bar).
2. Open **GE Movie** in BlueStacks. Turn off BlueStacks' game controls / key mapping for
   this app so the arrows reach it.
3. Keyboard = remote: **arrow keys** move, **Enter** = OK, **Esc** = Back.
4. A new test build installs over the old one the same way (sign-ins are kept).

## Updates

The app checks GitHub when it starts (and every 6 hours while open). When a new build is
there it asks **"Update available – Install?"**; choose Install. The first time, Android asks
to allow GE Movie to install apps: turn it on and press Back, the install continues.
Sign-ins and settings are kept.
| Play/Pause, ⏩ ⏪ | Control the video on the page | Same |
| Channel +/− | Scroll a page up/down | — |

## 1. Get the APK (built by GitHub)

1. Create a new **empty** repository on GitHub, e.g. `gemovie-tv`
   (public makes the TV download link below work without signing in).
2. Upload all files from this folder to it (keep the folder structure,
   including `.github/workflows/build.yml`).
3. Open the **Actions** tab: the "Build APK" run takes ~5 minutes.
4. When it's green, the APK is at
   `https://github.com/<your-user>/gemovie-tv/releases/download/latest/gemovie-tv.apk`
   (also under the run's *Artifacts*).

Every change you push builds a new APK at the same link.

## 2. Install it on the Bravia

**Allow sideloading (once):** Settings → Device Preferences → Security & restrictions →
Unknown sources → turn on for the app you install with (Downloader or File manager).

**Easiest: Downloader app**
1. On the TV, install **Downloader** (by AFTVnews) from Google Play.
2. Type the release link above and open it; it downloads and offers to install.

**Or with a USB stick**
1. Copy `gemovie-tv.apk` to a USB stick and plug it into the TV.
2. Open it with a file manager app (e.g. *File Commander* from Google Play) → Install.

The app appears on the home screen as **GE Movie** (Apps row). You can move it to the
favourites row with a long press on OK.

## Settings in the code

Top of `app/src/main/java/com/atabesha/gemovietv/MainActivity.java`:

- `START_URL` – page that opens first.
- `ALLOWED_DOMAINS` – the app only navigates to these sites, which stops ad popups
  taking over. If a real link is blocked, a "Blocked: host" message shows; add that host.
- `DESKTOP_MODE` – `true` asks the site for its desktop layout.
- `VIEWPORT_WIDTH` – page width the site is laid out at (1280 fits the TV well;
  bigger = smaller text, more items per row).
- `BLOCKED_HOSTS` – ad servers whose requests are dropped.

Navigation logic (what gets highlighted, how it moves, video control) is in
`app/src/main/assets/tvnav.js`.

## Notes

- OK sends a real touch tap at the highlighted item, so buttons inside video players
  (which are usually embedded from another site) work too.
- Videos with DRM (Widevine) may not play in a WebView. Normal streams (HLS, MP4) are fine.
- Opening the project in Android Studio also works (it will offer to set up Gradle).
