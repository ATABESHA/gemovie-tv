package com.atabesha.kinogo;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;

/**
 * Full-screen native player for direct streams (HLS / MP4).
 * Remote: OK = pause/play, ◀ ▶ = 10 s back/forward (hold to go faster), ▲ ▼ = show the controls,
 * Back = close. The position is saved, so the movie continues where it stopped.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 10; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

    private ExoPlayer player;
    private PlayerView view;
    private TextView seekLabel;
    private JSONObject session;
    private JSONObject source;
    private String key;
    private boolean live;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean failed;
    private boolean retried;
    private int seekStreak;

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
        key = session.optString("key", "");
        live = session.optBoolean("live", false);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new PlayerView(this);
        view.setKeepScreenOn(true);
        view.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        view.setControllerShowTimeoutMs(3500);
        view.setShowNextButton(false);
        view.setShowPreviousButton(false);
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Title in the top-left corner while the controls are visible.
        TextView title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setShadowLayer(6, 0, 0, Color.BLACK);
        String sub = session.optString("sub", "");
        String label = source.optString("label", "");
        title.setText(session.optString("title", "") + (sub.isEmpty() ? "" : "  ·  " + sub)
                + (label.isEmpty() || sub.contains(label) ? "" : "  ·  " + label));
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.gravity = Gravity.TOP | Gravity.START;
        tlp.setMargins(48, 32, 48, 0);
        root.addView(title, tlp);
        view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) v -> title.setVisibility(v));

        // "+30 s" bubble while seeking with the controls hidden.
        seekLabel = new TextView(this);
        seekLabel.setTextColor(Color.WHITE);
        seekLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        seekLabel.setBackgroundColor(0x99000000);
        seekLabel.setPadding(28, 12, 28, 12);
        seekLabel.setVisibility(View.GONE);
        FrameLayout.LayoutParams slp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.gravity = Gravity.CENTER;
        root.addView(seekLabel, slp);
        setContentView(root);

        // Request headers the stream needs (found inside a web player: its Referer, cookies…).
        Map<String, String> headers = new HashMap<>();
        JSONObject h = source.optJSONObject("headers");
        String ua = UA;
        if (h != null) {
            for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                String k = it.next();
                if (k.equalsIgnoreCase("User-Agent")) ua = h.optString(k);
                else headers.put(k, h.optString(k));
            }
        }
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(ua)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(20000)
                .setDefaultRequestProperties(headers);

        // A larger buffer than the default: smoother on a busy Wi-Fi / slow server.
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(20000, 120000, 2500, 5000)
                .build();

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
                .setLoadControl(load)
                .setSeekBackIncrementMs(10000)
                .setSeekForwardIncrementMs(10000)
                .build();
        view.setPlayer(player);

        String url = source.optString("url");
        MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
        String type = source.optString("type").toLowerCase(Locale.ROOT);
        String path = url.toLowerCase(Locale.ROOT).split("\\?")[0];
        if (type.equals("hls") || type.equals("m3u8") || path.endsWith(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if (type.equals("dash") || path.endsWith(".mpd")) item.setMimeType(MimeTypes.APPLICATION_MPD);
        player.setMediaItem(item.build());

        long start = session.optLong("start", -1);
        if (start < 0 && !live) start = savedPosition();
        if (start > 0) {
            player.seekTo(start);
            Toast.makeText(this, "▶ " + time(start), Toast.LENGTH_SHORT).show();
        }

        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                // A network hiccup: try the same server once more from the same place before moving on.
                int code = error.errorCode;
                if (!retried && code >= 2000 && code < 3000) {
                    retried = true;
                    Log.w("Kinogo", "retry after " + error.getErrorCodeName());
                    ui.postDelayed(() -> { if (player != null) { player.prepare(); player.play(); } }, 1500);
                    return;
                }
                Log.w("Kinogo", "player error " + error.getErrorCodeName() + " " + error.getMessage());
                onFail();
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                Log.i("Kinogo", "player state " + state + " at " + player.getCurrentPosition() + " / " + player.getDuration());
                if (state == Player.STATE_READY) retried = false;
                if (state == Player.STATE_ENDED) {
                    forget();
                    if (!playNext()) finish();
                }
            }
        });
        if (session.optBoolean("mute")) player.setVolume(0f);
        if (BuildConfig.DEBUG) player.addAnalyticsListener(new androidx.media3.exoplayer.util.EventLogger("KinogoExo"));
        Log.i("Kinogo", "play " + source.optString("label") + " " + url);
        player.setPlayWhenReady(true);
        player.prepare();
        ui.postDelayed(saver, 15000);
    }

    /**
     * Series: at the end of an episode the next one starts (session.next, filled by the page:
     * [{key, sub, meta, source}, …]).
     */
    private boolean playNext() {
        org.json.JSONArray next = session.optJSONArray("next");
        if (next == null || next.length() == 0) return false;
        try {
            JSONObject n = next.getJSONObject(0);
            org.json.JSONArray rest = new org.json.JSONArray();
            for (int i = 1; i < next.length(); i++) rest.put(next.get(i));
            JSONObject s = new JSONObject();
            s.put("key", n.optString("key"));
            s.put("title", session.optString("title"));
            s.put("sub", n.optString("sub"));
            s.put("meta", n.optJSONObject("meta"));
            s.put("sources", new org.json.JSONArray().put(n.getJSONObject("source")));
            s.put("index", 0);
            s.put("start", -1);   // its own saved place, if any
            s.put("next", rest);
            Toast.makeText(this, "▶ " + n.optString("sub"), Toast.LENGTH_LONG).show();
            Playback.open(this, s);
            finish();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** This stream doesn't play: show its web player instead, or try the next server. */
    private void onFail() {
        if (failed) return;
        failed = true;
        String embed = source.optString("embed", "");
        try {
            if (!embed.isEmpty()) {
                // A stream found inside a web player but refused here: use that web player as it is.
                JSONObject web = new JSONObject();
                web.put("label", source.optString("label"));
                web.put("type", "embed");
                web.put("url", embed);
                web.put("noSniff", true);
                web.put("found", true);
                session.getJSONArray("sources").put(session.optInt("index", 0), web);
                Playback.open(this, session);
            } else {
                Playback.next(this, session, source.optString("label", "Server") + ": error");
            }
        } catch (Exception ignored) {
        }
        finish();
    }

    // ------------------------------------------------------------------ remote control

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        if (player == null) return super.dispatchKeyEvent(e);
        if (code == KeyEvent.KEYCODE_BACK) {
            if (down) return true;
            if (view.isControllerFullyVisible() && player.isPlaying()) {
                view.hideController();
                return true;
            }
            finish();
            return true;
        }
        // With the controls hidden the arrows seek straight away, like on a streaming app.
        if (!view.isControllerFullyVisible()) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    if (live) return true;
                    if (down) {
                        seekStreak = e.getRepeatCount() == 0 ? 0 : seekStreak + 1;
                        long step = seekStreak > 20 ? 60000 : seekStreak > 6 ? 30000 : 10000;
                        long to = player.getCurrentPosition() + (code == KeyEvent.KEYCODE_DPAD_LEFT ? -step : step);
                        long dur = player.getDuration();
                        if (dur != C.TIME_UNSET) to = Math.min(to, Math.max(0, dur - 3000));
                        to = Math.max(0, to);
                        player.seekTo(to);
                        showSeek(time(to) + (dur != C.TIME_UNSET ? "  /  " + time(dur) : ""));
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                case KeyEvent.KEYCODE_NUMPAD_ENTER:
                    if (!down) {
                        player.setPlayWhenReady(!player.getPlayWhenReady());
                        view.showController();
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    if (!down) view.showController();
                    return true;
            }
        }
        return view.dispatchKeyEvent(e) || super.dispatchKeyEvent(e);
    }

    private final Runnable hideSeek = () -> seekLabel.setVisibility(View.GONE);

    private void showSeek(String text) {
        seekLabel.setText(text);
        seekLabel.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideSeek);
        ui.postDelayed(hideSeek, 1200);
    }

    private static String time(long ms) {
        long s = ms / 1000;
        return s >= 3600 ? String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
                : String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60);
    }

    // ------------------------------------------------------------------ saved positions

    private final Runnable saver = new Runnable() {
        @Override
        public void run() {
            save();
            ui.postDelayed(this, 15000);
        }
    };

    private long savedPosition() {
        try {
            String v = MainActivity.progressPrefs(this).getString(key, null);
            if (v == null) return 0;
            JSONObject o = new JSONObject(v);
            long pos = o.optLong("pos"), dur = o.optLong("dur");
            if (pos < 30000 || (dur > 0 && pos > dur - 120000)) return 0;
            return pos;
        } catch (Exception e) {
            return 0;
        }
    }

    private void save() {
        if (player == null || live || key.isEmpty() || failed) return;
        long pos = player.getCurrentPosition(), dur = player.getDuration();
        if (dur == C.TIME_UNSET || dur <= 0 || pos < 30000) return;
        if (pos > dur * 0.95) { forget(); return; }
        try {
            JSONObject o = new JSONObject();
            o.put("pos", pos);
            o.put("dur", dur);
            o.put("ts", System.currentTimeMillis());
            o.put("meta", session.optJSONObject("meta"));
            MainActivity.progressPrefs(this).edit().putString(key, o.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private void forget() {
        if (!key.isEmpty()) MainActivity.progressPrefs(this).edit().remove(key).apply();
    }

    @Override
    protected void onPause() {
        super.onPause();
        save();
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
