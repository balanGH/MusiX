package com.musix.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import androidx.annotation.RequiresApi;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import org.json.JSONException;

/**
 * MusicLibrary — the phone's audio files through MediaStore: listing the
 * library (read-only), and saving separated stems under Music/MusiX/Stems.
 *
 * Source of truth: native/android/MusicLibraryPlugin.java in the MusiX repo.
 * scripts/apply-android-native.mjs copies it into the generated android/
 * project and registers it in MainActivity; edit the repo copy, not the copy.
 *
 * The JS side (src/core/platform/nativeSource.ts) lists tracks with scan() and
 * then reads the files itself through Capacitor's local server
 * (/_capacitor_file_/<absolute path>), so no audio bytes cross the bridge.
 *
 * Written in Java rather than Kotlin on purpose: the Capacitor template is a
 * Java project, so this compiles without adding the Kotlin Gradle plugin.
 */
@CapacitorPlugin(
    name = "MusicLibrary",
    permissions = {
        // Android 13+ (API 33) replaced storage access with per-media permissions.
        @Permission(alias = MusicLibraryPlugin.ALIAS_MEDIA_AUDIO, strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        // Android 12 and older. Declared with maxSdkVersion=32 in the manifest.
        @Permission(alias = MusicLibraryPlugin.ALIAS_LEGACY_STORAGE, strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MusicLibraryPlugin extends Plugin {

    static final String ALIAS_MEDIA_AUDIO = "mediaAudio";
    static final String ALIAS_LEGACY_STORAGE = "legacyStorage";

    /** The alias JS sees. It maps onto whichever real permission this API level uses. */
    private static final String ALIAS_AUDIO = "audio";

    private static String platformAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? ALIAS_MEDIA_AUDIO : ALIAS_LEGACY_STORAGE;
    }

    private PermissionState audioState() {
        PermissionState state = getPermissionState(platformAlias());
        return state == null ? PermissionState.DENIED : state;
    }

    /**
     * Reports a single "audio" alias instead of the two internal ones, because
     * only one of them is ever meaningful on a given device: asking for
     * READ_MEDIA_AUDIO on Android 12 (or READ_EXTERNAL_STORAGE on 13+) is
     * always denied, which would make a combined alias permanently "denied".
     */
    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        result.put(ALIAS_AUDIO, audioState().toString());
        call.resolve(result);
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (audioState() == PermissionState.GRANTED) {
            checkPermissions(call);
            return;
        }
        requestPermissionForAlias(platformAlias(), call, "audioPermissionCallback");
    }

    /** Capacitor calls this after the system dialog; it has already recorded "never ask again". */
    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        checkPermissions(call);
    }

    /** Open this app's page in Android Settings, for a permanently denied permission. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * Every audio file MediaStore knows about, on internal storage and SD cards.
     *
     * Resolves { tracks: [{ id, path, relativePath, name, size, modifiedMs, durationMs, mimeType }] }.
     * relativePath is null below Android 10, where JS derives it from path.
     */
    @PluginMethod
    public void scan(PluginCall call) {
        if (audioState() != PermissionState.GRANTED) {
            call.reject("MusiX does not have permission to read music on this phone.", "PERMISSION_DENIED");
            return;
        }
        // Off the plugin thread: a large library can take a moment to query.
        getBridge().execute(() -> {
            try {
                JSObject result = new JSObject();
                result.put("tracks", queryTracks());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not read the music library: " + error.getMessage(), "SCAN_FAILED", error);
            }
        });
    }

    private JSArray queryTracks() {
        boolean hasRelativePath = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        String[] projection = hasRelativePath
            ? new String[] {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DATA,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.DATE_MODIFIED,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.MIME_TYPE,
                MediaStore.MediaColumns.RELATIVE_PATH
            }
            : new String[] {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DATA,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.DATE_MODIFIED,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.MIME_TYPE
            };

        // IS_MUSIC alone misses audio outside the standard folders on some
        // phones, so any audio/* file is included. JS filters by extension and
        // lets the user exclude folders such as WhatsApp voice notes.
        String selection = MediaStore.Audio.Media.IS_MUSIC + " != 0 OR " + MediaStore.Audio.Media.MIME_TYPE + " LIKE 'audio/%'";

        JSArray tracks = new JSArray();
        try (
            Cursor cursor = getContext()
                .getContentResolver()
                .query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, projection, selection, null, null)
        ) {
            if (cursor == null) return tracks;

            int idCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
            int dataCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
            int nameCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
            int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
            int modifiedCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED);
            int durationCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
            int mimeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
            int relativeCol = hasRelativePath ? cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.RELATIVE_PATH) : -1;

            while (cursor.moveToNext()) {
                String path = cursor.getString(dataCol);
                // Without an absolute path the file cannot be read; skip it.
                if (path == null || path.isEmpty()) continue;

                JSObject track = new JSObject();
                track.put("id", cursor.getLong(idCol));
                track.put("path", path);
                track.put("relativePath", relativeCol >= 0 ? cursor.getString(relativeCol) : null);
                track.put("name", cursor.getString(nameCol));
                track.put("size", cursor.getLong(sizeCol));
                // DATE_MODIFIED is in seconds.
                track.put("modifiedMs", cursor.getLong(modifiedCol) * 1000L);
                track.put("durationMs", cursor.getLong(durationCol));
                track.put("mimeType", cursor.getString(mimeCol));
                tracks.put(track);
            }
        }
        return tracks;
    }

    // -----------------------------------------------------------------------
    // Separated stems, saved under Music/MusiX/Stems/<song>/
    // -----------------------------------------------------------------------

    /** Below Music/. The phone library scan skips it (src/core/platform/nativeLibrary.ts). */
    private static final String STEMS_DIR = "MusiX/Stems";

    /**
     * Download { url } into Music/MusiX/Stems/<folder>/<fileName>.
     *
     * Resolves { path } (absolute). The phone fetches the file itself, so the
     * bytes never cross the JS bridge. Uses MediaStore, which on Android 10+
     * lets an app create files in Music/ without any storage permission; older
     * versions would need WRITE_EXTERNAL_STORAGE, so they are refused instead.
     */
    @PluginMethod
    public void saveFromUrl(PluginCall call) {
        String url = call.getString("url");
        String folder = call.getString("folder");
        String fileName = call.getString("fileName");
        if (url == null || folder == null || fileName == null) {
            call.reject("url, folder and fileName are required.", "BAD_ARGUMENTS");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Saving stems on the phone needs Android 10 or newer.", "UNSUPPORTED");
            return;
        }
        getBridge().execute(() -> {
            try {
                JSObject result = new JSObject();
                result.put("path", downloadToMusic(url, folder, fileName));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not save " + fileName + ": " + error.getMessage(), "SAVE_FAILED", error);
            }
        });
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private String downloadToMusic(String url, String folder, String fileName) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        Uri collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String relativePath = Environment.DIRECTORY_MUSIC + "/" + STEMS_DIR + "/" + folder + "/";

        // Saving the same song again replaces its files instead of MediaStore
        // adding "vocals (1).mp3" next to them.
        deleteSaved(resolver, collection, relativePath, fileName);

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "audio/mpeg");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        // Hidden from other apps until the download has finished.
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = resolver.insert(collection, values);
        if (item == null) throw new IOException("Android refused to create the file");

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("the PC answered HTTP " + status);

            try (InputStream in = connection.getInputStream(); OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IOException("could not open the new file");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            }

            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, done, null, null);
        } catch (IOException | RuntimeException error) {
            // Never leave a half-written file behind.
            resolver.delete(item, null, null);
            throw error;
        } finally {
            if (connection != null) connection.disconnect();
        }

        String path = pathOf(resolver, item);
        if (path == null) throw new IOException("saved, but Android did not report where");
        return path;
    }

    /** Delete this app's earlier copy of <relativePath><fileName>, if any. */
    @RequiresApi(Build.VERSION_CODES.Q)
    private void deleteSaved(ContentResolver resolver, Uri collection, String relativePath, String fileName) {
        String selection = MediaStore.MediaColumns.RELATIVE_PATH + " = ? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " = ?";
        try (
            Cursor cursor = resolver.query(collection, new String[] { MediaStore.MediaColumns._ID }, selection, new String[] { relativePath, fileName }, null)
        ) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                try {
                    resolver.delete(Uri.withAppendedPath(collection, String.valueOf(cursor.getLong(0))), null, null);
                } catch (SecurityException notOurs) {
                    // Saved by an earlier install of the app, so not ours to
                    // delete any more; MediaStore will pick another name.
                }
            }
        }
    }

    private String pathOf(ContentResolver resolver, Uri item) {
        try (Cursor cursor = resolver.query(item, new String[] { MediaStore.MediaColumns.DATA }, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    /** Delete saved stems by absolute path. Resolves { deleted }. Missing files are skipped. */
    @PluginMethod
    public void deleteFiles(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null) {
            call.reject("paths is required.", "BAD_ARGUMENTS");
            return;
        }
        getBridge().execute(() -> {
            try {
                List<String> list = paths.toList();
                ContentResolver resolver = getContext().getContentResolver();
                Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                int deleted = 0;
                for (String path : list) {
                    int rows = 0;
                    try {
                        rows = resolver.delete(collection, MediaStore.MediaColumns.DATA + " = ?", new String[] { path });
                    } catch (SecurityException notOurs) {
                        // Falls through to the plain file delete below.
                    }
                    if (rows == 0 && new File(path).delete()) rows = 1;
                    deleted += rows;
                }
                JSObject result = new JSObject();
                result.put("deleted", deleted);
                call.resolve(result);
            } catch (JSONException error) {
                call.reject("paths must be a list of strings.", "BAD_ARGUMENTS", error);
            } catch (Exception error) {
                call.reject("Could not delete the stems: " + error.getMessage(), "DELETE_FAILED", error);
            }
        });
    }
}
