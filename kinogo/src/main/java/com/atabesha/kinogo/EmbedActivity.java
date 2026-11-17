package com.atabesha.kinogo;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Opens a server's web player ("embed") in a locked-down web view:
 *  - ad and tracker hosts are blocked, pop-up windows and redirects to other sites are refused;
 *  - the page is watched for the video stream (.m3u8 / .mp4); when it shows up, it is handed
 *    to the native player, so the web player (and its ads) is never used to watch;
 *  - the player is "clicked" in the middle a few times, since most only load the stream after Play;
 *  - if nothing is found, the page stays on screen with a pointer: arrows move it, OK clicks.
 */
public class EmbedActivity extends Activity {

    /** Requests to these hosts get an empty answer. */
    static final String[] BLOCKED = {
            "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
            "googletagmanager.com", "googletagservices.com", "adservice.google.com", "imasdk.googleapis.com",
            "popads.net", "popcash.net", "propellerads.com", "adsterra.com", "exoclick.com", "juicyads.com",
            "onclickads.net", "onclkds.com", "adcash.com", "hilltopads.net", "a-ads.com", "mgid.com",
            "taboola.com", "outbrain.com", "yandex.ru/ads", "mc.yandex.ru", "an.yandex.ru", "adfox.ru",
            "facebook.net", "connect.facebook.net", "hotjar.com", "clarity.ms", "scorecardresearch.com",
            "adnxs.com", "rubiconproject.com", "pubmatic.com", "criteo.com", "amazon-adsystem.com",
            "unityads.unity3d.com", "applovin.com", "inmobi.com", "vidoomy.com", "aniview.com",
            "betweendigital.com", "otm-r.com", "adriver.ru", "begun.ru", "admixer.net", "bidvertiser.com",
            "revcontent.com", "zeroredirect", "realsrv.com", "tsyndicate.com", "trafficjunky.net",
            "adspyglass.com", "pushnami.com", "onesignal.com", "push.express", "clickadu.com",
            "acint.net", "dtscout.com", "dtscdn.com", "histats.com", "statcounter.com", "cloudflareinsights.com",
            // found on the Kinogo player pages themselves
            "moviead55.ru", "graphicslab.io", "kodir2.github.io", "videodb.cloud/check_publishers",
            "yandex-metrica-watch", "mc.yandex.com", "rendex-sdk",
    };
    /** Media files from these look like ads, not the movie. */
    private static final Pattern AD_MEDIA = Pattern.compile(
            "(?i)(/ads?/|[/._-]vast|preroll|pre-roll|advert|/promo/|/banner|creative|/reklama|/intro\\.)");
    // ".mp4/" with a slash: KVS-style players (/get_file/…/x_720p.mp4/)
    private static final Pattern STREAM = Pattern.compile("(?i)^https?://[^?#]+\\.(m3u8|mp4|mkv)/?(\\?|#|$)");
    private static final Pattern STREAM_LOOSE = Pattern.compile("(?i)(\\.m3u8|/get_file/.+\\.mp4)");

    private WebView web;
    private FrameLayout root;
    private View cursor;
    private TextView hint;
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCallback;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private JSONObject session;
    private JSONObject source;
    private boolean sniff;
    private boolean handedOver;
    private String pageHost;
    private boolean firstPageDone;
    private String pendingMp4;
    private Map<String, String> pendingMp4Headers;
    private float cx, cy;
    private int moveStreak;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        try {
            session = new JSONObject(getIntent().getStringExtra(Playback.EXTRA));
            source = session.getJSONArray("sources").getJSONObject(session.optInt("index", 0));
        } catch (Exception e) {
            finish();
            return;
        }
        sniff = !source.optBoolean("noSniff", false);
        String url = source.optString("url");
        pageHost = Uri.parse(url).getHost();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        hint = new TextView(this);
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        hint.setPadding(28, 14, 28, 14);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xCC000000);
        bg.setCornerRadius(40);
        hint.setBackground(bg);
        FrameLayout.LayoutParams hlp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        hlp.topMargin = 28;
        root.addView(hint, hlp);
        setHint(sniff ? "⏳ " + source.optString("label", "") + " — ვეძებ ვიდეოს… / Looking for the video…"
                : "◀ ▲ ▼ ▶ + OK — Play.  Back — გასვლა / exit");

        // Pointer for pressing buttons on the web player with the remote.
        cursor = new View(this);
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(0xDDE50914);
        dot.setStroke(4, Color.WHITE);
        cursor.setBackground(dot);
        int size = dp(22);
        root.addView(cursor, new FrameLayout.LayoutParams(size, size));
        cursor.setVisibility(View.GONE);
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        // Pop-ups: allowed in principle, then refused in onCreateWindow (so they never open).
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(Color.BLACK);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        if (sniff) {
            // A <video src="….m3u8"> is played by Android itself, without passing through
            // shouldInterceptRequest; a small script in every frame reports such addresses.
            web.addJavascriptInterface(new Finder(), "KinogoEmbed");
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(web, FINDER_JS, java.util.Collections.singleton("*"));
            }
        }
        web.setFocusable(true);
        web.requestFocus();

        Map<String, String> h = new java.util.HashMap<>();
        h.put("Referer", "https://kinogo.com.ge/");
        web.loadUrl(url, h);

        cx = 0.5f;
        cy = 0.5f;
        if (sniff) {
            // Most players load the stream only after Play is pressed.
            ui.postDelayed(() -> tapCenter(), 3500);
            ui.postDelayed(() -> tapCenter(), 7000);
            ui.postDelayed(() -> tapCenter(), 11000);
            ui.postDelayed(this::giveUpSniffing, 16000);
        } else {
            showCursor();
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void setHint(String text) {
        hint.setText(text);
        hint.setVisibility(View.VISIBLE);
    }

    /** Nothing found by itself: let the user press Play with the pointer (the stream is still watched for). */
    private void giveUpSniffing() {
        if (handedOver || isFinishing()) return;
        setHint("◀ ▲ ▼ ▶ + OK — დააჭირეთ Play-ს / press Play.  ⏩ — შემდეგი სერვერი / next server");
        showCursor();
        ui.postDelayed(() -> { if (!handedOver) hint.setVisibility(View.GONE); }, 9000);
    }

    // ------------------------------------------------------------------ finding the stream

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            String url = req.getUrl().toString();
            String host = req.getUrl().getHost();
            if (isBlocked(host, url)) return empty();
            if (BuildConfig.DEBUG) Log.d("Kinogo", "req " + url);
            if (sniff && !handedOver && looksLikeStream(url)) candidate(url, req.getRequestHeaders());
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            if (!req.isForMainFrame()) return false;
            Uri u = req.getUrl();
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            if (!scheme.startsWith("http")) return true;           // intent://, market:// …
            if (isBlocked(u.getHost(), u.toString())) return true;
            // The first redirects of the page itself are fine; after that the page stays where it is
            // (players send a click on the video to an ad site).
            if (!firstPageDone) {
                pageHost = u.getHost();
                return false;
            }
            return !sameSite(u.getHost(), pageHost);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            firstPageDone = true;
            // Hide overlays that sit on top of players (ad layers), make the video fill the page.
            view.evaluateJavascript(
                    "(function(){try{var st=document.createElement('style');st.textContent=" +
                    "'html,body{background:#000!important}';document.documentElement.appendChild(st);" +
                    "var v=document.querySelector('video');if(v){v.muted=" + session.optBoolean("mute") + ";var p=v.play&&v.play();if(p&&p.catch)p.catch(function(){});}" +
                    "}catch(e){}})()", null);
        }
    }

    /** Runs in every frame: reports the address of any <video>/<source> that is a real file. */
    private static final String FINDER_JS =
            "(function(){var seen={};function chk(){try{var l=document.querySelectorAll('video,source');" +
            "for(var i=0;i<l.length;i++){var s=l[i].currentSrc||l[i].src;" +
            "if(s&&!/^(blob|data):/.test(s)&&!seen[s]){seen[s]=1;window.KinogoEmbed&&KinogoEmbed.found(s,location.href);}}}catch(e){}}" +
            "setInterval(chk,700);})();";

    private class Finder {
        @JavascriptInterface
        public void found(String url, String page) {
            if (url == null || !looksLikeStream(url) || isBlocked(Uri.parse(url).getHost(), url)) return;
            Map<String, String> h = new java.util.HashMap<>();
            if (page != null && page.startsWith("http")) {
                h.put("Referer", page);
                Uri p = Uri.parse(page);
                h.put("Origin", p.getScheme() + "://" + p.getHost());
            }
            candidate(url, h);
        }
    }

    /** A stream address seen in the page (any thread). */
    private void candidate(String url, Map<String, String> headers) {
        ui.post(() -> {
            if (handedOver) return;
            if (url.toLowerCase(Locale.ROOT).contains(".m3u8")) { handOver(url, headers); return; }
            // An .mp4 may be an ad before the film: wait a moment for an .m3u8.
            if (pendingMp4 != null) return;
            pendingMp4 = url;
            pendingMp4Headers = headers;
            ui.postDelayed(() -> { if (!handedOver && pendingMp4 != null) handOver(pendingMp4, pendingMp4Headers); }, 2500);
        });
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            return false; // no pop-ups, ever
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            fullView = view;
            fullCallback = callback;
            root.addView(view, 1, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        @Override
        public void onHideCustomView() {
            if (fullView != null) root.removeView(fullView);
            fullView = null;
            if (fullCallback != null) fullCallback.onCustomViewHidden();
            fullCallback = null;
        }
    }

    static boolean isBlocked(String host, String url) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        String lower = url.toLowerCase(Locale.ROOT);
        for (String d : BLOCKED) {
            if (d.contains("/")) {
                if (lower.contains(d)) return true;
            } else if (host.equals(d) || host.endsWith("." + d) || (!d.contains(".") && host.contains(d))) {
                return true;
            }
        }
        return false;
    }

    private static boolean looksLikeStream(String url) {
        if (AD_MEDIA.matcher(url).find()) return false;
        return STREAM.matcher(url).find() || STREAM_LOOSE.matcher(url).find();
    }

    private static boolean sameSite(String a, String b) {
        if (a == null || b == null) return false;
        return base(a).equals(base(b));
    }

    private static String base(String host) {
        String[] p = host.toLowerCase(Locale.ROOT).split("\\.");
        return p.length <= 2 ? host.toLowerCase(Locale.ROOT) : p[p.length - 2] + "." + p[p.length - 1];
    }

    private static WebResourceResponse empty() {
        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
    }

    /** Found the stream: play it in the native player, with the headers the page used. */
    private void handOver(String url, Map<String, String> reqHeaders) {
        if (handedOver || isFinishing()) return;
        handedOver = true;
        Log.i("Kinogo", "found stream " + url);
        try {
            JSONObject headers = new JSONObject();
            if (reqHeaders != null) {
                for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                    String k = e.getKey();
                    if (k.equalsIgnoreCase("Referer") || k.equalsIgnoreCase("Origin") || k.equalsIgnoreCase("User-Agent")) {
                        headers.put(k, e.getValue());
                    }
                }
            }
            if (!headers.has("User-Agent")) headers.put("User-Agent", web.getSettings().getUserAgentString());
            if (!headers.has("Referer") && web.getUrl() != null) headers.put("Referer", web.getUrl());
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) headers.put("Cookie", cookie);

            JSONObject found = new JSONObject();
            found.put("label", source.optString("label"));
            found.put("type", url.toLowerCase(Locale.ROOT).contains(".m3u8") ? "hls" : "mp4");
            found.put("url", url);
            found.put("headers", headers);
            found.put("embed", source.optString("url"));
            found.put("found", true);

            // Put the found stream in place of this web player and open it in the native player.
            JSONArray src = session.getJSONArray("sources");
            src.put(session.optInt("index", 0), found);
            Playback.open(this, session);
        } catch (Exception ignored) {
        }
        finish();
    }

    // ------------------------------------------------------------------ remote control

    private void showCursor() {
        cursor.setVisibility(View.VISIBLE);
        placeCursor();
    }

    private void placeCursor() {
        int w = root.getWidth(), h = root.getHeight();
        if (w == 0) { root.post(this::placeCursor); return; }
        cursor.setX(cx * w - cursor.getWidth() / 2f);
        cursor.setY(cy * h - cursor.getHeight() / 2f);
    }

    private void tapCenter() {
        if (handedOver || isFinishing() || cursor.getVisibility() == View.VISIBLE) return;
        tap(0.5f, 0.5f);
    }

    private void tap(float fx, float fy) {
        final View target = fullView != null ? fullView : web;
        final float x = fx * target.getWidth(), y = fy * target.getHeight();
        final long t = SystemClock.uptimeMillis();
        MotionEvent d = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0);
        d.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        target.dispatchTouchEvent(d);
        d.recycle();
        ui.postDelayed(() -> {
            MotionEvent u = MotionEvent.obtain(t, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0);
            u.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            target.dispatchTouchEvent(u);
            u.recycle();
        }, 60);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        switch (code) {
            case KeyEvent.KEYCODE_BACK:
                if (!down) {
                    if (fullView != null) web.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null);
                    finish();
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                if (!down && !handedOver) {
                    handedOver = true;
                    if (Playback.next(this, session, source.optString("label", "Server"))) finish();
                    else handedOver = false;
                }
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
                if (cursor.getVisibility() != View.VISIBLE) showCursor();
                if (down) {
                    moveStreak = e.getRepeatCount() == 0 ? 0 : moveStreak + 1;
                    float step = moveStreak > 8 ? 0.04f : 0.015f;
                    if (code == KeyEvent.KEYCODE_DPAD_LEFT) cx -= step;
                    if (code == KeyEvent.KEYCODE_DPAD_RIGHT) cx += step;
                    if (code == KeyEvent.KEYCODE_DPAD_UP) cy -= step * 16 / 9f;
                    if (code == KeyEvent.KEYCODE_DPAD_DOWN) cy += step * 16 / 9f;
                    cx = Math.max(0.01f, Math.min(0.99f, cx));
                    cy = Math.max(0.01f, Math.min(0.99f, cy));
                    placeCursor();
                }
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                if (!down) {
                    if (cursor.getVisibility() != View.VISIBLE) showCursor();
                    tap(cx, cy);
                }
                return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (web != null) {
            web.stopLoading();
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
