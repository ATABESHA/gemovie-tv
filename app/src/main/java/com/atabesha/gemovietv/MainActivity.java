package com.atabesha.gemovietv;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen WebView wrapper for gemovie.tv (formerly ge.movie), driven by the TV remote.
 * Arrow keys move a highlight between items (tvnav.js); OK sends a real
 * touch tap to the highlighted item, so no mouse pointer is ever needed.
 */
public class MainActivity extends Activity {

    // ---- Settings you may want to change -------------------------------
    /**
     * The site's address. It has moved before (ge.movie -> gemovie.tv): when the old
     * address answers with a permanent redirect, the app switches to the new one by itself
     * and keeps the profiles and lists saved under the old one.
     */
    static final String DEFAULT_HOST = "gemovie.tv";
    /**
     * The app's own TV interface (assets/tvui.html). It is loaded under the site's
     * address (https://<site>/tv-app), so it may read the site's pages, but none of the
     * site's own scripts, ads or sliders run.
     */
    static final String UI_PATH = "/tv-app";
    /** Main-page navigation is only allowed to these domains (and their subdomains), plus the current site. */
    static final String[] ALLOWED_DOMAINS = {"gemovie.tv", "ge.movie"};
    /**
     * true = tell sites this is a Linux PC. Off: Cloudflare's browser check compares that
     * claim with what the engine itself reports (Android) and keeps failing when they differ.
     */
    static final boolean DESKTOP_MODE = false;
    /** Page width in CSS pixels the site is laid out at (0 = leave the site's own setting). */
    static final int VIEWPORT_WIDTH = 1280;
    /** Requests to these hosts are dropped (ads / popups). */
    static final String[] BLOCKED_HOSTS = {
            "doubleclick.net", "googlesyndication.com", "googleadservices.com",
            "adservice.google.com", "popads.net", "popcash.net", "propellerads.com",
            "adsterra.com", "exoclick.com", "juicyads.com", "onclickads.net",
            "onclkds.com", "adcash.com", "hilltopads.net", "a-ads.com",
            "mgid.com", "taboola.com", "outbrain.com"
    };
    // --------------------------------------------------------------------

    /** true = phone/tablet build (touch), false = TV build (remote). Set per build in app/build.gradle. */
    static final boolean TOUCH = "touch".equals(BuildConfig.UI_MODE);

    /**
     * Background downloads (TMDB texts, translations, trailer search) share two threads, so
     * scrolling quickly through many titles can't start dozens of large downloads at once.
     */
    private static final ExecutorService NET = Executors.newFixedThreadPool(2);

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Set<String> extraAllowedHosts = new HashSet<>();
    private final Updater updater = new Updater(this);

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private String navScript;
    private String lastFailedUrl;
    private volatile boolean editing;
    private volatile boolean playing;
    /** True while the arrows move over the player's own controls in full screen. */
    private volatile boolean fsControls;
    /** Phone/tablet: a movie or trailer is open (screen turned sideways, bars hidden). */
    private boolean videoOpen;
    private long lastBackPress;

    /** Where the site is now (saved, so a move found once is remembered). */
    private android.content.SharedPreferences prefs;
    private String host;
    /** The next page load replaces the history (Back must not return to a helper page). */
    private boolean clearHistoryOnLoad;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!TOUCH) getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);

        prefs = getSharedPreferences("site", MODE_PRIVATE);
        host = prefs.getString("host", null);
        if (host == null) {
            // First start with this version: everything so far was saved under ge.movie.
            host = DEFAULT_HOST;
            prefs.edit().putString("host", host).putString("migrate_from", "ge.movie").commit();
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        navScript = readAsset("tvnav.js")
                .replace("__VIEWPORT_WIDTH__", String.valueOf(TOUCH ? 0 : VIEWPORT_WIDTH))
                .replace("__MODE__", BuildConfig.UI_MODE)
                .replace("__SITE_HOST__", host);
        createWebView();

        loadTvUi();
        web.requestFocus();
        showSplash();
        checkSiteMoved();
    }

    private String uiUrl() {
        return "https://" + host + UI_PATH;
    }

    private void createWebView() {
        web = new WebView(this);
        root.addView(web, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupWebView();
    }

    /**
     * The page's engine crashed, or Android stopped it to free memory (it can happen after
     * hours of video on a TV with little RAM). Start a fresh page instead of closing the app.
     */
    private void rebuildWebView() {
        if (customView != null) {
            root.removeView(customView);
            customView = null;
            customViewCallback = null;
        }
        root.removeView(web);
        web.destroy();
        editing = false;
        playing = false;
        fsControls = false;
        setVideoMode(false);
        updateKeepScreenOn();
        createWebView();
        loadTvUi();
        web.requestFocus();
    }

    // ------------------------------------------------------------ start-up animation

    /** Logo animation with sound (res/raw/splash.mp4); the movie screens load behind it. */
    private FrameLayout splash;

    private void showSplash() {
        splash = new FrameLayout(this);
        splash.setBackgroundColor(Color.BLACK);
        android.widget.VideoView video = new android.widget.VideoView(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        lp.gravity = android.view.Gravity.CENTER;
        splash.addView(video, lp);
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        video.setVideoURI(Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.splash));
        video.setOnCompletionListener(mp -> hideSplash());
        video.setOnErrorListener((mp, what, extra) -> { hideSplash(); return true; });
        if (TOUCH) splash.setOnClickListener(v -> hideSplash());      // a tap skips it
        video.start();
        ui.postDelayed(this::hideSplash, 8000);   // safety net if the video never ends
    }

    private void hideSplash() {
        final FrameLayout s = splash;
        if (s == null) return;
        splash = null;
        s.animate().alpha(0f).setDuration(400).withEndAction(() -> {
            for (int i = 0; i < s.getChildCount(); i++) {
                View c = s.getChildAt(i);
                if (c instanceof android.widget.VideoView) ((android.widget.VideoView) c).stopPlayback();
            }
            root.removeView(s);
            web.requestFocus();
            // Make sure no text box got the page's focus on the way.
            js("document.activeElement && document.activeElement.blur && document.activeElement.blur()", null);
        }).start();
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(buildUserAgent(s.getUserAgentString()));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.addJavascriptInterface(new Bridge(), "TVApp");

        // Inject the navigation script into every page and every frame (video players
        // usually live in iframes) before the site's own scripts run.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, navScript, Collections.singleton("*"));
        }

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
    }

    private static String buildUserAgent(String ua) {
        // Hide that this is an embedded WebView ("; wv"), which some sites block.
        ua = ua.replace("; wv", "");
        // Phones keep their own (mobile) identity, so the video player shows touch controls.
        if (DESKTOP_MODE && !TOUCH) {
            ua = ua.replaceFirst("\\(Linux; Android[^)]*\\)", "(X11; Linux x86_64)")
                    .replaceFirst(" Version/[0-9.]+", "")
                    .replace(" Mobile Safari", " Safari");
        }
        return ua;
    }

    // ---------------------------------------------------------------- keys

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;

        // During the start-up animation: OK or Back skips it, other keys wait.
        if (splash != null) {
            if (down && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                    || code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE)) hideSplash();
            return true;
        }

        if (cfWeb != null) return cfKey(e);

        // Esc = Back, so a PC keyboard (BlueStacks) works like the TV remote.
        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE) {
            if (down && e.getRepeatCount() == 0) handleBack();
            return true;
        }

        // Phones and tablets: everything else is typing, volume etc. as usual.
        if (TOUCH) return super.dispatchKeyEvent(e);

        String cmd = commandFor(code);
        if (cmd == null) {
            // A button the app doesn't use yet (e.g. extra app buttons on the remote):
            // show its code once, so it can be given a job.
            if (down && e.getRepeatCount() == 0 && !isSystemKey(code)) {
                toast("ღილაკი: " + KeyEvent.keyCodeToString(code).replace("KEYCODE_", "") + " (" + code + ")");
            }
            return super.dispatchKeyEvent(e);
        }

        // While typing in a text field, let left/right move the caret, OK submit,
        // and the I key type an "i".
        if (editing && customView == null
                && (cmd.equals("left") || cmd.equals("right") || cmd.equals("ok")
                    || code == KeyEvent.KEYCODE_I)) {
            return super.dispatchKeyEvent(e);
        }

        if (down) {
            js("window.__tv&&__tv.key('" + cmd + "'," + (customView != null) + ","
                    + e.getRepeatCount() + ")", null);
        }
        return true;
    }

    /** Keys the TV itself handles (volume, power, home…): no code message for these. */
    private static boolean isSystemKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_VOLUME_UP: case KeyEvent.KEYCODE_VOLUME_DOWN:
            case KeyEvent.KEYCODE_VOLUME_MUTE: case KeyEvent.KEYCODE_MUTE:
            case KeyEvent.KEYCODE_POWER: case KeyEvent.KEYCODE_HOME:
            case KeyEvent.KEYCODE_SETTINGS: case KeyEvent.KEYCODE_TV_INPUT:
            case KeyEvent.KEYCODE_SHIFT_LEFT: case KeyEvent.KEYCODE_SHIFT_RIGHT:
            case KeyEvent.KEYCODE_CTRL_LEFT: case KeyEvent.KEYCODE_CTRL_RIGHT:
            case KeyEvent.KEYCODE_ALT_LEFT: case KeyEvent.KEYCODE_ALT_RIGHT:
            case KeyEvent.KEYCODE_UNKNOWN:
                return true;
            default:
                // Letters, digits and symbols are for typing in search.
                return code >= KeyEvent.KEYCODE_0 && code <= KeyEvent.KEYCODE_9
                        || code >= KeyEvent.KEYCODE_A && code <= KeyEvent.KEYCODE_Z
                        || code == KeyEvent.KEYCODE_SPACE || code == KeyEvent.KEYCODE_DEL
                        || code == KeyEvent.KEYCODE_COMMA || code == KeyEvent.KEYCODE_PERIOD;
        }
    }

    private static String commandFor(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A: return "ok";
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "playpause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
            case KeyEvent.KEYCODE_MEDIA_STOP: return "stop";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_NEXT: return "ff";
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS: return "rw";
            case KeyEvent.KEYCODE_PROG_RED:
            case KeyEvent.KEYCODE_INFO:
            case KeyEvent.KEYCODE_I: return "info";
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP: return "pageup";
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return "pagedown";
            default: return null;
        }
    }

    private void handleBack() {
        // A player panel or list is open: Back closes it first (the player
        // reports again if something is still open).
        if (fsControls) {
            fsControls = false;
            js("window.__tv&&__tv.key('back',true,0)", null);
            return;
        }
        if (customView != null) {
            exitFullscreen();
            return;
        }
        // Let the page close a menu / dialog / text field first.
        js("window.__tv?__tv.back():false", value -> {
            if ("true".equals(value)) return;
            if (web.canGoBack()) {
                web.goBack();
            } else {
                long now = SystemClock.uptimeMillis();
                if (now - lastBackPress < 2000) {
                    finish();
                } else {
                    lastBackPress = now;
                    toast("Press Back again to exit");
                }
            }
        });
    }

    /**
     * A real touch tap at a point given as fractions of the screen area showing the
     * page: the WebView normally, the full-screen player view while a video is full screen.
     */
    private void tap(float fx, float fy) {
        final View target = customView != null ? customView : web;
        float x = fx * target.getWidth();
        float y = fy * target.getHeight();
        long t = SystemClock.uptimeMillis();
        MotionEvent d = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0);
        d.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        target.dispatchTouchEvent(d);
        d.recycle();
        ui.postDelayed(() -> {
            MotionEvent u = MotionEvent.obtain(t, SystemClock.uptimeMillis(),
                    MotionEvent.ACTION_UP, x, y, 0);
            u.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            target.dispatchTouchEvent(u);
            u.recycle();
        }, 50);
    }

    // ---------------------------------------------------------- fullscreen

    private void exitFullscreen() {
        if (customView == null) return;
        fsControls = false;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        updateKeepScreenOn();
        if (TOUCH) hideSystemBars(videoOpen);
        web.requestFocus();
    }

    /** Phone/tablet: a movie turns the screen sideways and hides the status/navigation bars. */
    private void setVideoMode(boolean on) {
        if (!TOUCH) return;
        videoOpen = on;
        setRequestedOrientation(on ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        hideSystemBars(on);
    }

    private void hideSystemBars(boolean hide) {
        androidx.core.view.WindowInsetsControllerCompat c = androidx.core.view.WindowCompat
                .getInsetsController(getWindow(), getWindow().getDecorView());
        if (hide) {
            c.setSystemBarsBehavior(androidx.core.view.WindowInsetsControllerCompat
                    .BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(androidx.core.view.WindowInsetsCompat.Type.systemBars());
        }
    }

    private void updateKeepScreenOn() {
        if (customView != null || playing) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            updateKeepScreenOn();
            if (TOUCH) hideSystemBars(true);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // Avoids the grey "play" placeholder WebView shows before a video loads.
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }
    }

    // ------------------------------------------------------------ loading

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri url = req.getUrl();
            String scheme = url.getScheme();
            if (!"http".equals(scheme) && !"https".equals(scheme)) return true; // intent://, market:// …
            if (!req.isForMainFrame()) return false;
            String host = url.getHost();
            if (isBlockedHost(host)) return true;
            if (isAllowedHost(host)) return false;
            // A server redirect from an allowed page (e.g. to a mirror domain) is fine.
            if (req.isRedirect()) return false;
            toast("Blocked: " + host);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            if (isBlockedHost(req.getUrl().getHost())) {
                // A clean "not found" makes ad loaders give up instead of retrying.
                return new WebResourceResponse("text/plain", "utf-8", 404, "Blocked",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            return null;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (clearHistoryOnLoad && url != null && url.startsWith(uiUrl())) {
                clearHistoryOnLoad = false;
                view.clearHistory();
            }
            String host = Uri.parse(url).getHost();
            if (host != null && !isBlockedHost(host)) extraAllowedHosts.add(host);
            // Fallback for older WebViews without document-start injection
            // (the script ignores a second copy).
            view.evaluateJavascript(navScript, null);
            view.evaluateJavascript("window.__tv&&__tv.pageReady()", null);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            lastFailedUrl = req.getUrl().toString();
            String html = "<html><body style='background:#111;color:#eee;font-family:sans-serif;"
                    + "display:flex;flex-direction:column;align-items:center;justify-content:center;"
                    + "height:100vh;margin:0'><h1>Can't load the page</h1><p>"
                    + escape(String.valueOf(err.getDescription()))
                    + "</p><button style='font-size:28px;padding:16px 40px;margin-top:20px'"
                    + " onclick='TVApp.retry()'>Try again</button></body></html>";
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            // Without this Android closes the whole app when the page's engine dies.
            if (view == web) ui.post(MainActivity.this::rebuildWebView);
            return true;
        }
    }

    // ------------------------------------------------------- site address

    /**
     * The site's old address answers with a permanent redirect: move to the new address.
     * Runs in the background at start-up and when the app's page reads fail.
     */
    private void checkSiteMoved() {
        final String current = host;
        NET.execute(() -> {
            String moved = permanentRedirectHost("https://" + current + "/");
            if (moved == null || moved.equals(current)) return;
            ui.post(() -> {
                if (!current.equals(host)) return;
                host = moved;
                prefs.edit().putString("host", moved).putString("migrate_from", current).commit();
                toast(t("საიტი გადავიდა: ", "Сайт переехал: ", "The site moved to ") + moved);
                loadTvUi();
            });
        });
    }

    private static String permanentRedirectHost(String url) {
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
            int code = c.getResponseCode();
            if (code != 301 && code != 308) return null;
            String loc = c.getHeaderField("Location");
            if (loc == null) return null;
            java.net.URL to = new java.net.URL(new java.net.URL(url), loc);
            if (!"https".equals(to.getProtocol()) || to.getHost() == null || to.getHost().isEmpty()) return null;
            return to.getHost().toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Text in the app language (the page tells the app; Georgian until then). */
    private static String t(String ka, String ru, String en) {
        return "ru".equals(Updater.lang) ? ru : "en".equals(Updater.lang) ? en : ka;
    }

    private boolean isAllowedHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.equals(this.host) || host.endsWith("." + this.host)) return true;
        if (extraAllowedHosts.contains(host)) return true;
        for (String d : ALLOWED_DOMAINS) {
            if (host.equals(d) || host.endsWith("." + d)) return true;
        }
        return false;
    }

    private static boolean isBlockedHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        for (String d : BLOCKED_HOSTS) {
            if (host.equals(d) || host.endsWith("." + d)) return true;
        }
        return false;
    }

    // -------------------------------------------------------- JS bridge

    /** Methods callable from tvnav.js as window.TVApp.* */
    private class Bridge {
        @JavascriptInterface
        public void setEditing(boolean value) {
            editing = value;
        }

        @JavascriptInterface
        public void setPlaying(boolean value) {
            playing = value;
            ui.post(MainActivity.this::updateKeepScreenOn);
        }

        @JavascriptInterface
        public String webViewVersion() {
            PackageInfo p = WebViewCompat.getCurrentWebViewPackage(MainActivity.this);
            return p == null ? "unknown" : p.versionName;
        }

        /**
         * Title and description in the app language (ru/en): TMDB's own page for the movie,
         * machine translation of the Georgian text for whatever TMDB doesn't have.
         * Answers the page with __tvui.onLocal(key, {title, plot, facts:[...]}).
         */
        @JavascriptInterface
        public void localize(String key, String kind, String tmdbId, String lang, String geoPlot, String geoFacts) {
            NET.execute(() -> {
                String title = "", plot = "";
                if (tmdbId != null && !tmdbId.isEmpty()) {
                    String[] tp = tmdbTexts("tv".equals(kind) ? "tv" : "movie", tmdbId, lang);
                    if (tp != null) { title = tp[0]; plot = tp[1]; }
                }
                if (plot.isEmpty() && geoPlot != null && !geoPlot.isEmpty()) plot = translate(geoPlot, lang);
                String facts = geoFacts == null || geoFacts.isEmpty() ? "" : translate(geoFacts, lang);
                org.json.JSONObject o = new org.json.JSONObject();
                try {
                    o.put("title", title);
                    o.put("plot", plot);
                    org.json.JSONArray fa = new org.json.JSONArray();
                    if (!facts.isEmpty()) for (String f : facts.split("\n")) fa.put(f.trim());
                    o.put("facts", fa);
                } catch (Exception ignored) {
                }
                String js = "window.__tvui&&__tvui.onLocal&&__tvui.onLocal(" + org.json.JSONObject.quote(key) + "," + o + ")";
                ui.post(() -> js(js, null));
            });
        }

        /** Finds a trailer on YouTube (the first search result) and tells the page. */
        @JavascriptInterface
        public void findTrailer(String query, String key) {
            NET.execute(() -> {
                String id = youtubeSearch(query);
                if (id == null) return;
                ui.post(() -> js("window.__tvui&&__tvui.onTrailer&&__tvui.onTrailer("
                        + org.json.JSONObject.quote(key) + "," + org.json.JSONObject.quote(id) + ")", null));
            });
        }

        /** Phone/tablet: the page opened (true) or closed (false) a movie or trailer. */
        @JavascriptInterface
        public void setLandscape(boolean on) {
            ui.post(() -> setVideoMode(on));
        }

        @JavascriptInterface
        public void setLang(String lang) {
            Updater.lang = lang == null ? "ka" : lang;
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void checkUpdate() {
            ui.post(updater::checkNow);
        }

        @JavascriptInterface
        public void setFsControls(boolean value) {
            fsControls = value;
        }

        @JavascriptInterface
        public void tap(float fx, float fy) {
            ui.post(() -> MainActivity.this.tap(fx, fy));
        }

        /** The site answered with Cloudflare's browser check instead of a page. */
        @JavascriptInterface
        public void cfCheck() {
            ui.post(MainActivity.this::showCfCheck);
        }

        @JavascriptInterface
        public void retry() {
            ui.post(() -> {
                if (lastFailedUrl == null || lastFailedUrl.contains(UI_PATH)) loadTvUi();
                else web.loadUrl(lastFailedUrl);
            });
        }

        /** The page couldn't reach the site at all: maybe it moved again. */
        @JavascriptInterface
        public void recheckSite() {
            ui.post(MainActivity.this::checkSiteMoved);
        }

        /** Everything the app saved under the old address (profiles, lists, settings). */
        @JavascriptInterface
        public void savedData(String json) {
            ui.post(() -> {
                if (prefs.getString("migrate_from", null) == null) return;
                android.content.SharedPreferences.Editor e = prefs.edit().remove("migrate_from");
                if (json != null && json.length() > 2) e.putString("restore", json);
                e.commit();
                clearHistoryOnLoad = true;
                loadTvUi();
            });
        }

        /** The saved data is now stored under the new address. */
        @JavascriptInterface
        public void restored() {
            prefs.edit().remove("restore").apply();
        }
    }

    // ------------------------------------------------------------ helpers

    private static final java.util.regex.Pattern YT_ID =
            java.util.regex.Pattern.compile("\"videoRenderer\":\\{\"videoId\":\"([\\w-]{11})\"");
    private static final java.util.regex.Pattern YT_ANY =
            java.util.regex.Pattern.compile("\"videoId\":\"([\\w-]{11})\"");

    // ------------------------------------------------ texts in other languages

    private static String httpGet(String url, int maxChars) {
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
            c.setRequestProperty("Accept-Language", "en-US,en;q=0.9,ru;q=0.8");
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buf = new char[16384];
                int n;
                while ((n = r.read(buf)) > 0 && sb.length() < maxChars) sb.append(buf, 0, n);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String metaContent(String html, String prop) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "<meta[^>]+(?:property|name)=\"" + java.util.regex.Pattern.quote(prop) + "\"[^>]+content=\"([^\"]*)\"")
                .matcher(html);
        return m.find() ? unescapeHtml(m.group(1)).trim() : "";
    }

    private static String unescapeHtml(String s) {
        return s.replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&");
    }

    /** TMDB's page in the wanted language: { title, overview } ("" when it has none). */
    static String[] tmdbTexts(String kind, String id, String lang) {
        String loc = "ru".equals(lang) ? "ru-RU" : "en-US";
        String html = httpGet("https://www.themoviedb.org/" + kind + "/" + id + "?language=" + loc, 1_500_000);
        if (html == null) return null;
        String title = metaContent(html, "og:title").replaceAll("\\s*\\(\\d{4}\\)\\s*$", "");
        String plot = "";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "<div class=\"overview\"[^>]*>\\s*<p>(.*?)</p>", java.util.regex.Pattern.DOTALL).matcher(html);
        if (m.find()) plot = unescapeHtml(m.group(1).replaceAll("<[^>]+>", "")).trim();
        if (plot.isEmpty()) plot = metaContent(html, "og:description");
        // TMDB's "no translation yet" notice is not a description
        if (plot.contains("We don't have an overview") || plot.contains("нет описания") || plot.contains("нет перевода")) plot = "";
        return new String[]{title, plot};
    }

    /** Machine translation from Georgian (Google's free web endpoint). "" if it fails. */
    static String translate(String text, String lang) {
        try {
            String url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ka&tl="
                    + ("ru".equals(lang) ? "ru" : "en") + "&dt=t&q=" + java.net.URLEncoder.encode(text, "UTF-8");
            String body = httpGet(url, 200_000);
            if (body == null) return "";
            org.json.JSONArray parts = new org.json.JSONArray(body).getJSONArray(0);
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < parts.length(); i++) {
                org.json.JSONArray p = parts.optJSONArray(i);
                if (p != null && !p.isNull(0)) out.append(p.getString(0));
            }
            return out.toString().trim();
        } catch (Exception e) {
            return "";
        }
    }

    /** YouTube search page, first video result. Runs on a background thread. */
    private static String youtubeSearch(String query) {
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL u = new java.net.URL("https://www.youtube.com/results?search_query="
                    + java.net.URLEncoder.encode(query, "UTF-8"));
            c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
            c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
            c.setRequestProperty("Cookie", "SOCS=CAI; CONSENT=YES+1");   // skip the EU consent page
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buf = new char[16384];
                int n;
                while ((n = r.read(buf)) > 0 && sb.length() < 2_000_000) sb.append(buf, 0, n);
            }
            java.util.regex.Matcher m = YT_ID.matcher(sb);
            if (m.find()) return m.group(1);
            m = YT_ANY.matcher(sb);
            return m.find() ? m.group(1) : null;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------- Cloudflare browser check

    /*
     * The site sometimes asks Cloudflare to check the browser first. The app's interface
     * only downloads pages in the background, where that check can't run, so the real
     * site is opened here in a plain page the way any browser shows it. The check runs
     * by itself; if it shows a "verify you are human" box, the arrows move a pointer and
     * OK clicks. Once the site's own page appears, the browser has its pass (a cookie
     * shared with the interface) and the interface reloads.
     */
    private WebView cfWeb;
    private FrameLayout cfLayer;
    private View cfPointer;
    private android.widget.TextView cfInfo;
    private float cfX, cfY;

    private final Runnable cfPoll = new Runnable() {
        @Override
        public void run() {
            if (cfWeb == null) return;
            cfWeb.evaluateJavascript("(function(){var c=!!window._cf_chl_opt||/just a moment/i.test(document.title);"
                    + "var real=!c&&!!document.querySelector('a[href*=\"/movie/\"],a[href*=\"/serial/\"]');"
                    + "return real?'ok':c?'check':'wait'})()", r -> {
                if (cfWeb == null) return;
                if ("\"ok\"".equals(r)) { closeCfCheck(true); return; }
                ui.postDelayed(this, 1000);
            });
        }
    };

    private long cfCancelledAt;

    private void showCfCheck() {
        // Just cancelled with Back: don't pop up again for every row that fails.
        if (cfWeb != null || SystemClock.uptimeMillis() - cfCancelledAt < 30000) return;
        int dp = (int) getResources().getDisplayMetrics().density;
        cfLayer = new FrameLayout(this);
        cfLayer.setBackgroundColor(Color.BLACK);
        cfWeb = new WebView(this);
        WebSettings s = cfWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Same identity as the interface: the pass is only valid for the browser that got it.
        s.setUserAgentString(web.getSettings().getUserAgentString());
        CookieManager.getInstance().setAcceptThirdPartyCookies(cfWeb, true);
        cfWeb.setWebViewClient(new WebViewClient());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        lp.topMargin = 56 * dp;
        cfLayer.addView(cfWeb, lp);

        cfInfo = new android.widget.TextView(this);
        cfInfo.setTextColor(Color.WHITE);
        cfInfo.setTextSize(15);
        cfInfo.setPadding(16 * dp, 8 * dp, 16 * dp, 8 * dp);
        cfInfo.setBackgroundColor(0xFF1D4ED8);
        String wv = "?";
        try { wv = new Bridge().webViewVersion(); } catch (Exception ignored) { }
        int major = 0;
        try { major = Integer.parseInt(wv.split("\\.")[0]); } catch (Exception ignored) { }
        String old = major > 0 && major < 110
                ? "\n⚠ Android System WebView " + wv + " is old — update it in Google Play, the check may fail on it."
                : "";
        cfInfo.setText(host + " is checking the browser. Wait a few seconds. If a box appears, move the "
                + "pointer onto it with the arrows and press OK.  Back = cancel.   (WebView " + wv + ")" + old);
        cfLayer.addView(cfInfo, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        cfPointer = new View(this);
        android.graphics.drawable.GradientDrawable ring = new android.graphics.drawable.GradientDrawable();
        ring.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        ring.setColor(0x55FFFFFF);
        ring.setStroke(3 * dp, 0xFFFFCC00);
        cfPointer.setBackground(ring);
        cfLayer.addView(cfPointer, new FrameLayout.LayoutParams(28 * dp, 28 * dp));

        root.addView(cfLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        cfLayer.post(() -> {
            // Cloudflare's box usually sits on the left of the content column.
            cfX = cfLayer.getWidth() * 0.32f;
            cfY = cfLayer.getHeight() * 0.42f;
            moveCfPointer(0, 0);
        });
        cfWeb.loadUrl("https://" + host + "/");
        cfWeb.requestFocus();
        ui.postDelayed(cfPoll, 1500);
    }

    private void moveCfPointer(float dx, float dy) {
        if (cfLayer == null) return;
        cfX = Math.max(0, Math.min(cfLayer.getWidth() - 1, cfX + dx));
        cfY = Math.max(cfInfo.getHeight(), Math.min(cfLayer.getHeight() - 1, cfY + dy));
        cfPointer.setTranslationX(cfX - cfPointer.getWidth() / 2f);
        cfPointer.setTranslationY(cfY - cfPointer.getHeight() / 2f);
    }

    private boolean cfKey(KeyEvent e) {
        if (e.getAction() != KeyEvent.ACTION_DOWN) return true;
        float step = getResources().getDisplayMetrics().density * (e.getRepeatCount() > 3 ? 40 : 14);
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_DPAD_LEFT: moveCfPointer(-step, 0); break;
            case KeyEvent.KEYCODE_DPAD_RIGHT: moveCfPointer(step, 0); break;
            case KeyEvent.KEYCODE_DPAD_UP: moveCfPointer(0, -step); break;
            case KeyEvent.KEYCODE_DPAD_DOWN: moveCfPointer(0, step); break;
            case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER:
                if (e.getRepeatCount() == 0) cfClick();
                break;
            case KeyEvent.KEYCODE_BACK: case KeyEvent.KEYCODE_ESCAPE:
                if (e.getRepeatCount() == 0) closeCfCheck(false);
                break;
            default:
                return super.dispatchKeyEvent(e);
        }
        return true;
    }

    /** OK = a touch where the pointer is (the person clicks the box themselves). */
    private void cfClick() {
        final WebView w = cfWeb;
        final float x = cfX, y = cfY - ((FrameLayout.LayoutParams) w.getLayoutParams()).topMargin;
        if (y < 0) return;
        long t = SystemClock.uptimeMillis();
        MotionEvent d = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0);
        d.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        w.dispatchTouchEvent(d);
        d.recycle();
        ui.postDelayed(() -> {
            if (cfWeb != w) return;
            MotionEvent u = MotionEvent.obtain(t, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0);
            u.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            w.dispatchTouchEvent(u);
            u.recycle();
        }, 80);
    }

    private void closeCfCheck(boolean passed) {
        if (cfWeb == null) return;
        ui.removeCallbacks(cfPoll);
        root.removeView(cfLayer);
        cfWeb.destroy();
        cfWeb = null;
        cfLayer = null;
        CookieManager.getInstance().flush();
        if (!passed) cfCancelledAt = SystemClock.uptimeMillis();
        if (passed) {
            toast("✓ " + host);
            loadTvUi();
        }
        web.requestFocus();
    }

    private void loadTvUi() {
        // The site moved: what the app saved (profiles, Continue, My List, settings) is stored
        // under the old address. Read it there first; this page needs no network.
        String from = prefs.getString("migrate_from", null);
        if (from != null && !from.equals(host)) {
            web.loadDataWithBaseURL("https://" + from + UI_PATH,
                    "<html><body style='background:#000'><script>var d='{}';"
                            + "try{d=JSON.stringify(Object.assign({},localStorage))}catch(e){}"
                            + "TVApp.savedData(d)</script></body></html>",
                    "text/html", "utf-8", null);
            return;
        }
        // ...and write it under the new address, before the app's own code reads it.
        // Keys that already exist there are kept.
        String restore = prefs.getString("restore", null);
        String pre = restore == null ? "" : "<script>(function(d){try{for(var k in d)"
                + "if(localStorage.getItem(k)===null)localStorage.setItem(k,d[k]);TVApp.restored()}catch(e){}})("
                + restore.replace("</", "<\\/") + ")</script>";

        // The page runs under the site's address, so the app's logo is embedded into it.
        String html = readAsset("tvui.html")
                .replace("<head>", "<head>" + pre)
                .replace("__LOGO__", "data:image/png;base64," + readAssetBase64("logo.png"))
                .replace("__AV_PARENTS__", "data:image/jpeg;base64," + readAssetBase64("av_parents.jpg"))
                .replace("__AV_SON__", "data:image/jpeg;base64," + readAssetBase64("av_son.jpg"))
                .replace("__MODE__", BuildConfig.UI_MODE)
                .replace("__VIEWPORT__", TOUCH
                        ? "width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no"
                        : "width=" + VIEWPORT_WIDTH);
        web.loadDataWithBaseURL(uiUrl(), html, "text/html", "utf-8", uiUrl());
    }

    private String readAssetBase64(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
        } catch (IOException e) {
            return "";
        }
    }

    private void js(String code, android.webkit.ValueCallback<String> cb) {
        web.evaluateJavascript(code, cb);
    }

    private void toast(String msg) {
        ui.post(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    // ---------------------------------------------------------- lifecycle

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        // Save sign-ins to disk now: if Android later closes the app, they'd otherwise be lost.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        updater.onResume();
    }

    @Override
    protected void onDestroy() {
        root.removeAllViews();
        web.destroy();
        super.onDestroy();
    }
}
