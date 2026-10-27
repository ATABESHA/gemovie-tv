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
 * Checks the GitHub "latest" release for a newer build and installs it.
 * The release holds gemovie-tv.apk and version.txt (the build number).
 */
final class Updater {
    static final String BASE = "https://github.com/ATABESHA/gemovie-tv/releases/download/latest/";
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
        busy = true;
        new Thread(() -> {
            try {
                int remote = Integer.parseInt(readText(BASE + "version.txt").trim());
                if (remote > currentVersion()) {
                    ui.post(() -> ask(remote));
                    return;
                }
            } catch (Exception ignored) {
                // Offline or no release yet: try again next time.
            }
            busy = false;
        }, "update-check").start();
    }

    @SuppressWarnings("deprecation")
    private int currentVersion() throws Exception {
        PackageInfo pi = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
    }

    private void ask(int remote) {
        if (act.isFinishing()) {
            busy = false;
            return;
        }
        new AlertDialog.Builder(act)
                .setTitle("Update available")
                .setMessage("A new version of GE Movie (build " + remote + ") is ready. Install it now?")
                .setPositiveButton("Install", (d, w) -> download())
                .setNegativeButton("Later", (d, w) -> busy = false)
                .setOnCancelListener(d -> busy = false)
                .show();
    }

    private void download() {
        toast("Downloading update…");
        new Thread(() -> {
            try {
                File dir = new File(act.getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache dir");
                File apk = new File(dir, "gemovie-tv.apk");
                HttpURLConnection c = open(BASE + "gemovie-tv.apk");
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
                    toast("Update download failed");
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
            toast("Allow GE Movie to install apps, then press Back");
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
            toast("Can't open the installer");
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
