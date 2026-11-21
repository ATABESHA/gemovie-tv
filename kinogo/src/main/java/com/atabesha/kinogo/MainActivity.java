package com.atabesha.kinogo;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Kinogo TV: the app's own remote-control interface (assets/index.html) on top of the
 * Kinogo catalogue's REST API. The page asks for data at /api/... ; this activity forwards
 * those requests to the API with the app key, so the page never needs the key itself.
 *
 * Nothing else is loaded: no ads, no analytics, no Google/Firebase services.
 */
public class MainActivity extends Activity {

    /** The catalogue's API (the same one the original Kinogo app uses). */
    static final String API = "https://geo.mevicer.ge/rest-api/v130/";
    /** The public key built into the original app; the API wants it in an "API-KEY" header. */
    static final String API_KEY = "ttohdhqbu8dtxmd40om3jdy6";

    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String UI_URL = ORIGIN + "/assets/index.html";

    /** Short-lived cache of API answers, so going back and forth between screens is instant. */
    private static final long CACHE_MS = 5 * 60 * 1000L;
    private static final Map<String, Object[]> cache = new LinkedHashMap<String, Object[]>(64, .75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Object[]> e) {
            return size() > 60;
        }
    };

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Updater updater = new Updater(this);
    private WebViewAssetLoader assets;
    private boolean pageReady;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);

        assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(Color.parseColor("#0b0c10"));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.addJavascriptInterface(new Bridge(), "KinogoApp");
        web.setWebViewClient(new Client());
        web.loadUrl(UI_URL);
        web.requestFocus();
        debugPlay(getIntent());
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        debugPlay(intent);
    }

    /** Test builds only: adb shell am start -n com.atabesha.kinogo/.MainActivity --es play '<session json>' */
    private void debugPlay(android.content.Intent intent) {
        if (!BuildConfig.DEBUG || intent == null || intent.getStringExtra("play") == null) return;
        String json = intent.getStringExtra("play");
        ui.postDelayed(() -> Playback.start(this, json), 500);
    }

    @Override
    protected void onResume() {
        super.onResume();
        updater.onResume();
        // Back from a movie: refresh "Continue watching".
        if (pageReady) web.evaluateJavascript("window.KG && KG.onResume && KG.onResume()", null);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Back goes to the page first (close details, leave search…); only the home screen closes the app. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if ((code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER)
                && android.os.SystemClock.uptimeMillis() < Updater.dialogUntil) {
            return true; // the press that answered the update question
        }
        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                if (!pageReady) { finish(); return true; }
                web.evaluateJavascript("window.KG ? KG.back() : false", v -> {
                    if (!"true".equals(v)) finish();
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    // ------------------------------------------------------------------ page loading

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if ("appassets.androidplatform.net".equals(u.getHost())) {
                String path = u.getPath() == null ? "" : u.getPath();
                if (path.startsWith("/api/")) return api(path.substring(5), u.getEncodedQuery());
                return assets.shouldInterceptRequest(u);
            }
            return null; // pictures etc. load normally
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            // The interface never leaves its own page.
            return !req.getUrl().toString().startsWith(ORIGIN);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
        }
    }

    /** Forwards /api/<path>?<query> to the catalogue's API with the app key. Runs on a WebView background thread. */
    private static WebResourceResponse api(String path, String query) {
        String url = API + path + (query == null ? "" : "?" + query);
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        Object[] hit;
        synchronized (cache) { hit = cache.get(url); }
        byte[] body;
        int code = 200;
        if (hit != null && System.currentTimeMillis() - (Long) hit[0] < CACHE_MS) {
            body = (byte[]) hit[1];
        } else {
            try {
                body = httpGet(url);
                synchronized (cache) { cache.put(url, new Object[]{System.currentTimeMillis(), body}); }
            } catch (Exception e) {
                code = 502;
                body = ("{\"error\":\"" + e.getClass().getSimpleName() + "\"}").getBytes(StandardCharsets.UTF_8);
            }
        }
        return new WebResourceResponse("application/json", "utf-8", code, code == 200 ? "OK" : "Bad Gateway",
                headers, new ByteArrayInputStream(body));
    }

    static byte[] httpGet(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(12000);
        c.setReadTimeout(30000);
        c.setRequestProperty("API-KEY", API_KEY);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", "KinogoTV/" + BuildConfig.VERSION_NAME + " (Android TV)");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new java.io.IOException("HTTP " + code);
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } finally {
            c.disconnect();
        }
    }

    static SharedPreferences progressPrefs(Context c) {
        return c.getSharedPreferences("progress", MODE_PRIVATE);
    }

    // ------------------------------------------------------------------ page → app

    /** Methods the page can call as window.KinogoApp.* */
    private class Bridge {
        /** Start a movie / episode / channel. json = a Playback session (see Playback.java). */
        @JavascriptInterface
        public void play(String json) {
            ui.post(() -> Playback.start(MainActivity.this, json));
        }

        /** Saved positions, for "Continue watching": {key: {pos, dur, ts, meta}} */
        @JavascriptInterface
        public String progress() {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<String, ?> e : progressPrefs(MainActivity.this).getAll().entrySet()) {
                if (!(e.getValue() instanceof String)) continue;
                if (!first) sb.append(',');
                first = false;
                sb.append(org.json.JSONObject.quote(e.getKey())).append(':').append((String) e.getValue());
            }
            return sb.append('}').toString();
        }

        @JavascriptInterface
        public void forget(String key) {
            progressPrefs(MainActivity.this).edit().remove(key).apply();
        }

        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public void checkUpdate() {
            ui.post(updater::checkNow);
        }

        @JavascriptInterface
        public void setLang(String lang) {
            Updater.lang = lang;
        }

        @JavascriptInterface
        public void exit() {
            ui.post(MainActivity.this::finish);
        }
    }
}
