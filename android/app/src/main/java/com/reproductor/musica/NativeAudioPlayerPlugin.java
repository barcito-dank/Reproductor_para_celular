package com.reproductor.musica;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

/**
 * Plugin Capacitor que puentea el Frontend React con MediaPlaybackService (ExoPlayer + Media3).
 */
@CapacitorPlugin(name = "NativeAudioPlayer")
public class NativeAudioPlayerPlugin extends Plugin implements MediaPlaybackService.ServiceEventListener {

    private static final int REQ_POST_NOTIFICATIONS = 9410;

    @Override
    public void load() {
        super.load();
        MediaPlaybackService.setServiceEventListener(this);
        requestNotificationPermissionIfNeeded();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null) {
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    getActivity(),
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    REQ_POST_NOTIFICATIONS
                );
            }
        }
    }

    @PluginMethod
    public void loadTrack(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("Contexto Android no disponible");
            return;
        }

        String url = call.getString("url", "");
        String filePath = call.getString("filePath", "");
        String title = call.getString("title", "Canción");
        String artist = call.getString("artist", "Artista Desconocido");
        String album = call.getString("album", "");
        String coverUrl = call.getString("coverUrl", null);
        Double durationObj = call.getDouble("duration", 0.0);
        Boolean autoPlayObj = call.getBoolean("autoPlay", true);

        double duration = durationObj != null ? durationObj : 0.0;
        boolean autoPlay = autoPlayObj == null || autoPlayObj;

        MediaPlaybackService.loadTrack(
            context,
            url,
            filePath,
            title,
            artist,
            album,
            coverUrl,
            duration,
            autoPlay
        );
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        Context context = getContext();
        if (context != null) {
            MediaPlaybackService.play(context);
        }
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        Context context = getContext();
        if (context != null) {
            MediaPlaybackService.pause(context);
        }
        call.resolve();
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Context context = getContext();
        Double positionObj = call.getDouble("position", 0.0);
        double positionSec = positionObj != null ? Math.max(0.0, positionObj) : 0.0;
        if (context != null) {
            MediaPlaybackService.seekTo(context, positionSec);
        }
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Context context = getContext();
        Double volumeObj = call.getDouble("volume", 1.0);
        float volume = volumeObj != null ? volumeObj.floatValue() : 1.0f;
        if (context != null) {
            MediaPlaybackService.setVolume(context, volume);
        }
        call.resolve();
    }

    @PluginMethod
    public void setEqualizerBands(PluginCall call) {
        Context context = getContext();
        JSArray gainsArray = call.getArray("gains");
        float[] gainsDb = new float[MediaPlaybackService.REACT_EQ_FREQUENCIES_HZ.length];

        if (gainsArray != null) {
            int count = Math.min(gainsDb.length, gainsArray.length());
            for (int i = 0; i < count; i++) {
                try {
                    double val = gainsArray.getDouble(i);
                    if (!Double.isNaN(val)) {
                        gainsDb[i] = (float) val;
                    }
                } catch (JSONException ignored) {
                }
            }
        }

        if (context != null) {
            MediaPlaybackService.setEqualizerBands(context, gainsDb);
        }
        call.resolve();
    }

    @PluginMethod
    public void getPlaybackState(PluginCall call) {
        MediaPlaybackService.runOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("isPlaying", MediaPlaybackService.isPlayingNow());
            ret.put("currentTime", MediaPlaybackService.getCurrentPositionSeconds());
            ret.put("duration", MediaPlaybackService.getDurationSeconds());
            call.resolve(ret);
        });
    }

    @Override
    public void onPlaybackProgress(double currentTimeSec, double durationSec, boolean isPlaying) {
        JSObject data = new JSObject();
        data.put("currentTime", currentTimeSec);
        data.put("duration", durationSec);
        data.put("isPlaying", isPlaying);
        notifyListeners("playbackProgress", data);
    }

    @Override
    public void onPlaybackStateChanged(boolean isPlaying, double currentTimeSec, double durationSec) {
        JSObject data = new JSObject();
        data.put("isPlaying", isPlaying);
        data.put("currentTime", currentTimeSec);
        data.put("duration", durationSec);
        notifyListeners("playbackStateChanged", data);
    }

    @Override
    public void onTrackEnded() {
        JSObject data = new JSObject();
        notifyListeners("trackEnded", data);
    }

    @Override
    public void onRemoteCommand(String command, @Nullable Double seekPositionSec) {
        JSObject data = new JSObject();
        data.put("command", command);
        data.put("action", command);
        if (seekPositionSec != null) {
            data.put("position", seekPositionSec);
            data.put("seekTime", seekPositionSec);
        }
        notifyListeners("remoteCommand", data);
    }

    @Override
    protected void handleOnDestroy() {
        MediaPlaybackService.setServiceEventListener(null);
        super.handleOnDestroy();
    }
}
