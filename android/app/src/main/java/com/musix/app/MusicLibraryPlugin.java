package com.musix.app;

import android.Manifest;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * MusicLibrary — read-only access to the phone's audio files through MediaStore.
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
}
