package com.atabesha.gemovietv;

import android.app.Activity;
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

/**
 * Full-screen WebView wrapper for ge.movie, driven by the TV remote.
 * Arrow keys move a highlight between items (tvnav.js); OK sends a real
 * touch tap to the highlighted item, so no mouse pointer is ever needed.
 */
public class MainActivity extends Activity {

    // ---- Settings you may want to change -------------------------------
    static final String START_URL = "https://ge.movie/";
    /** Main-page navigation is only allowed to these domains (and their subdomains). */
    static final String[] ALLOWED_DOMAINS = {"ge.movie"};
    /** true = ask the site for its desktop layout (usually best on a TV). */
    static final boolean DESKTOP_MODE = true;
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
    private long lastBackPress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        navScript = readAsset("tvnav.js")
                .replace("__VIEWPORT_WIDTH__", String.valueOf(VIEWPORT_WIDTH));
        setupWebView();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
        web.requestFocus();
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
        if (DESKTOP_MODE) {
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

        if (code == KeyEvent.KEYCODE_BACK) {
            if (down && e.getRepeatCount() == 0) handleBack();
            return true;
        }

        String cmd = commandFor(code);
        if (cmd == null) return super.dispatchKeyEvent(e);

        // While typing in a text field, let left/right move the caret and OK submit.
        if (editing && customView == null
                && (cmd.equals("left") || cmd.equals("right") || cmd.equals("ok"))) {
            return super.dispatchKeyEvent(e);
        }

        if (down) {
            js("window.__tv&&__tv.key('" + cmd + "'," + (customView != null) + ","
                    + e.getRepeatCount() + ")", null);
        }
        return true;
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
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP: return "pageup";
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return "pagedown";
            default: return null;
        }
    }

    private void handleBack() {
        if (customView != null) {
            if (fsControls) {
                // First Back hides the player-controls highlight; the next one leaves full screen.
                fsControls = false;
                js("window.__tv&&__tv.key('back',true,0)", null);
            } else {
                exitFullscreen();
            }
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
        web.requestFocus();
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
                return new WebResourceResponse("text/plain", "utf-8",
                        new ByteArrayInputStream(new byte[0]));
            }
            return null;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
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
    }

    private boolean isAllowedHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
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
        public void setFsControls(boolean value) {
            fsControls = value;
        }

        @JavascriptInterface
        public void tap(float fx, float fy) {
            ui.post(() -> MainActivity.this.tap(fx, fy));
        }

        @JavascriptInterface
        public void retry() {
            ui.post(() -> web.loadUrl(lastFailedUrl != null ? lastFailedUrl : START_URL));
        }
    }

    // ------------------------------------------------------------ helpers

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
