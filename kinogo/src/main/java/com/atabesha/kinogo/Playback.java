package com.atabesha.kinogo;

import android.app.Activity;
import android.content.Intent;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * One request to watch something, passed between the screens as JSON:
 * <pre>
 * { key:   "movie:13292" | "ep:13084:124784" | "tv:79"   (where the position is saved)
 *   title: "…", sub: "…", live: false,
 *   meta:  {…}                  (shown in "Continue watching", kept as is)
 *   sources: [{label, type, url, headers?, embed?}],
 *   index: 0,                   (the server being tried)
 *   start: 0 }                  (ms, optional)
 * </pre>
 * Direct streams (HLS / MP4) go to the native player. Web players ("embed") open in a
 * locked-down web view that looks for the stream inside the page and hands it to the
 * native player, so their ads never show. When a server fails, the next one is tried.
 */
final class Playback {
    static final String EXTRA = "session";

    private Playback() {}

    static void start(Activity from, String json) {
        try {
            open(from, new JSONObject(json));
        } catch (Exception e) {
            Toast.makeText(from, "Can't play this", Toast.LENGTH_LONG).show();
        }
    }

    static void open(Activity from, JSONObject s) throws Exception {
        JSONArray src = s.getJSONArray("sources");
        int i = s.optInt("index", 0);
        if (i >= src.length()) throw new IllegalStateException("no source");
        JSONObject cur = src.getJSONObject(i);
        Class<?> target = isDirect(cur) ? PlayerActivity.class : EmbedActivity.class;
        Intent it = new Intent(from, target);
        it.putExtra(EXTRA, s.toString());
        from.startActivity(it);
    }

    /** A stream the native player can open by itself. */
    static boolean isDirect(JSONObject src) {
        String type = src.optString("type").toLowerCase(Locale.ROOT);
        String url = src.optString("url").toLowerCase(Locale.ROOT);
        if (src.optBoolean("noSniff")) return false;
        if (type.equals("hls") || type.equals("mp4") || type.equals("m3u8") || type.equals("mkv")
                || type.equals("dash") || type.equals("direct")) return true;
        String path = url.contains("?") ? url.substring(0, url.indexOf('?')) : url;
        return path.endsWith(".m3u8") || path.endsWith(".mp4") || path.endsWith(".mkv") || path.endsWith(".mpd");
    }

    /**
     * The current server didn't work: try the next one, or give up.
     * @return true when another server is being opened
     */
    static boolean next(Activity from, JSONObject s, String why) {
        try {
            JSONArray src = s.getJSONArray("sources");
            int i = s.optInt("index", 0) + 1;
            // Skip copies of a server that was already tried (a stream found inside a web player).
            while (i < src.length() && src.getJSONObject(i).optBoolean("found")) i++;
            if (i >= src.length()) {
                Toast.makeText(from, why + " — no other server", Toast.LENGTH_LONG).show();
                return false;
            }
            s.put("index", i);
            Toast.makeText(from, why + " → " + src.getJSONObject(i).optString("label", "Server " + (i + 1)),
                    Toast.LENGTH_LONG).show();
            open(from, s);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
