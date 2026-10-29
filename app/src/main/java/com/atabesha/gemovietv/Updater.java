package com.atabesha.gemovietv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Checks GitHub for a newer build and installs it. Two release channels are checked,
 * and the newer one wins:
 *   "latest" - the TV release        (gemovie-tv.apk + version.txt)
 *   "test"   - every build of main    (gemovie-tv-test.apk + version.txt)
 * Runs by itself at start-up (then at most every 6 h) and from the app's Update button.
 */
final class Updater {
    static final String REPO = "https://github.com/ATABESHA/gemovie-tv/releases/download/";
    static final String[][] CHANNELS = {
            {"latest", "gemovie-tv.apk"},
            {"test", "gemovie-tv-test.apk"},
    };
    private static final long CHECK_EVERY_MS = 6 * 60 * 60 * 1000L;

    private final Activity act;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean busy;
    private long lastCheck = -CHECK_EVERY_MS;
    private File pendingApk;

    Updater(Activity activity) {
        act = activity;
    }

    /** Call from onResume: checks at start-up and then at most every 6 hours. */
    void onResume() {
        if (pendingApk != null && canInstall()) {
            File apk = pendingApk;
            pendingApk = null;
            install(apk);
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (busy || now - lastCheck < CHECK_EVERY_MS) return;
        lastCheck = now;
        check(false);
    }

    /** The app's Update button: check now and always say what was found. */
    void checkNow() {
        if (busy) { toast("განახლება უკვე მოწმდება…"); return; }
        lastCheck = SystemClock.elapsedRealtime();
        toast("ვამოწმებ განახლებას…");
        check(true);
    }

    private void check(boolean manual) {
        busy = true;
        new Thread(() -> {
            int best = -1;
            String bestApk = null;
            for (String[] ch : CHANNELS) {
                try {
                    int v = Integer.parseInt(readText(REPO + ch[0] + "/version.txt").trim());
                    if (v > best) { best = v; bestApk = REPO + ch[0] + "/" + ch[1]; }
                } catch (Exception ignored) {
                    // This channel has nothing yet, or we're offline.
                }
            }
            int current;
            try { current = currentVersion(); } catch (Exception e) { current = 0; }
            final int remote = best, have = current;
            final String apkUrl = bestApk;
            if (remote > have && apkUrl != null) {
                ui.post(() -> ask(remote, apkUrl));
                return;
            }
            busy = false;
            if (manual) {
                if (remote < 0) toast("GitHub-თან დაკავშირება ვერ მოხერხდა");
                else toast("უკვე უახლესი ვერსიაა (build " + have + ")");
            }
        }, "update-check").start();
    }

    @SuppressWarnings("deprecation")
    private int currentVersion() throws Exception {
        PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
    }

    private void ask(int remote, String apkUrl) {
        if (act.isFinishing()) {
            busy = false;
            return;
        }
        new AlertDialog.Builder(act)
                .setTitle("ახალი ვერსია")
                .setMessage("MyMovie-ს ახალი ვერსია (build " + remote + ") მზადაა. დავაყენო ახლა?")
                .setPositiveButton("დაყენება", (d, w) -> download(apkUrl))
                .setNegativeButton("მოგვიანებით", (d, w) -> busy = false)
                .setOnCancelListener(d -> busy = false)
                .show();
    }

    private void download(String apkUrl) {
        toast("ახალი ვერსია იტვირთება…");
        new Thread(() -> {
            try {
                File dir = new File(act.getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache dir");
                File apk = new File(dir, "gemovie-tv.apk");
                HttpURLConnection c = open(apkUrl);
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } finally {
                    c.disconnect();
                }
                ui.post(() -> {
                    busy = false;
                    install(apk);
                });
            } catch (Exception e) {
                ui.post(() -> {
                    busy = false;
                    toast("ჩამოტვირთვა ვერ მოხერხდა");
                });
            }
        }, "update-download").start();
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || act.getPackageManager().canRequestPackageInstalls();
    }

    private void install(File apk) {
        if (!canInstall()) {
            // Android asks once whether this app may install updates.
            pendingApk = apk;
            toast("მიეცით MyMovie-ს აპების დაყენების ნებართვა და დააჭირეთ Back-ს");
            try {
                act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + act.getPackageName())));
                return;
            } catch (Exception e) {
                pendingApk = null; // no such settings screen: let the installer ask instead
            }
        }
        Uri uri = FileProvider.getUriForFile(act, act.getPackageName() + ".files", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            act.startActivity(i);
        } catch (Exception e) {
            toast("დამყენებელი ვერ გაიხსნა");
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "GeMovieTV-Updater");
        int code = c.getResponseCode();
        if (code != 200) {
            c.disconnect();
            throw new IOException("HTTP " + code);
        }
        return c;
    }

    private static String readText(String url) throws IOException {
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    private void toast(String msg) {
        ui.post(() -> Toast.makeText(act, msg, Toast.LENGTH_LONG).show());
    }
}
