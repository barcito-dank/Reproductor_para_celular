package com.reproductor.musica;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.audiofx.Equalizer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.Arrays;

/**
 * Servicio nativo de reproducción en segundo plano basado en AndroidX Media3.
 * Mantiene vivo el motor ExoPlayer con WAKE_MODE_LOCAL, AudioFocus, MediaSession
 * (pantalla de bloqueo, cortina de notificaciones, botones Bluetooth) y Equalizer de hardware.
 */
@OptIn(markerClass = UnstableApi.class)
public class MediaPlaybackService extends MediaSessionService {

    private static final String TAG = "MediaPlaybackService";

    public static final int[] REACT_EQ_FREQUENCIES_HZ = new int[] {
        60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000
    };

    public interface ServiceEventListener {
        void onPlaybackProgress(double currentTimeSec, double durationSec, boolean isPlaying);
        void onPlaybackStateChanged(boolean isPlaying, double currentTimeSec, double durationSec);
        void onTrackEnded();
        void onRemoteCommand(String command, @Nullable Double seekPositionSec);
    }

    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static ExoPlayer exoPlayer;
    private static Equalizer hardwareEqualizer;
    private static int boundAudioSessionId = C.AUDIO_SESSION_ID_UNSET;
    private static float[] currentEqGainsDb = new float[REACT_EQ_FREQUENCIES_HZ.length];
    private static double fallbackDurationSec = 0.0;
    private static ServiceEventListener eventListener;
    private static boolean progressLoopRunning = false;

    private MediaSession mediaSession;

    private static final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            if (exoPlayer != null && exoPlayer.isPlaying()) {
                notifyProgressInternal();
                mainHandler.postDelayed(this, 500);
            } else {
                progressLoopRunning = false;
            }
        }
    };

    public static void setServiceEventListener(@Nullable ServiceEventListener listener) {
        eventListener = listener;
    }

    public static void runOnMainThread(@NonNull Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
    }

    public static synchronized ExoPlayer ensurePlayerInitialized(@NonNull Context context) {
        final Context appContext = context.getApplicationContext();
        if (exoPlayer != null) {
            return exoPlayer;
        }

        AudioAttributes audioAttributes = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build();

        exoPlayer = new ExoPlayer.Builder(appContext)
            .setAudioAttributes(audioAttributes, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build();

        exoPlayer.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (isPlaying) {
                    startProgressLoop();
                } else {
                    stopProgressLoop();
                }
                if (eventListener != null) {
                    eventListener.onPlaybackStateChanged(
                        isPlaying,
                        getCurrentPositionSeconds(),
                        getDurationSeconds()
                    );
                }
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) {
                    stopProgressLoop();
                    if (eventListener != null) {
                        eventListener.onTrackEnded();
                    }
                } else if (playbackState == Player.STATE_READY) {
                    bindEqualizerToSession(exoPlayer.getAudioSessionId());
                    if (eventListener != null) {
                        eventListener.onPlaybackStateChanged(
                            exoPlayer.isPlaying(),
                            getCurrentPositionSeconds(),
                            getDurationSeconds()
                        );
                    }
                }
            }

            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                bindEqualizerToSession(audioSessionId);
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                Log.w(TAG, "ExoPlayer error: " + error.getMessage(), error);
            }
        });

        bindEqualizerToSession(exoPlayer.getAudioSessionId());
        return exoPlayer;
    }

    private static void startProgressLoop() {
        if (!progressLoopRunning) {
            progressLoopRunning = true;
            mainHandler.removeCallbacks(progressRunnable);
            mainHandler.post(progressRunnable);
        }
    }

    private static void stopProgressLoop() {
        progressLoopRunning = false;
        mainHandler.removeCallbacks(progressRunnable);
    }

    private static void notifyProgressInternal() {
        if (exoPlayer == null || eventListener == null) return;
        eventListener.onPlaybackProgress(
            getCurrentPositionSeconds(),
            getDurationSeconds(),
            exoPlayer.isPlaying()
        );
    }

    public static double getCurrentPositionSeconds() {
        if (exoPlayer == null) return 0.0;
        long posMs = Math.max(0L, exoPlayer.getCurrentPosition());
        return posMs / 1000.0;
    }

    public static double getDurationSeconds() {
        if (exoPlayer == null) return fallbackDurationSec;
        long durMs = exoPlayer.getDuration();
        if (durMs == C.TIME_UNSET || durMs <= 0L) {
            return fallbackDurationSec;
        }
        return durMs / 1000.0;
    }

    public static boolean isPlayingNow() {
        return exoPlayer != null && exoPlayer.isPlaying();
    }

    public static void loadTrack(
        @NonNull Context context,
        @Nullable String url,
        @Nullable String filePath,
        @Nullable String title,
        @Nullable String artist,
        @Nullable String album,
        @Nullable String coverUrl,
        double durationSec,
        boolean autoPlay
    ) {
        final Context appContext = context.getApplicationContext();
        runOnMainThread(() -> {
            try {
                Intent serviceIntent = new Intent(appContext, MediaPlaybackService.class);
                appContext.startService(serviceIntent);
            } catch (Exception e) {
                Log.w(TAG, "No se pudo arrancar MediaPlaybackService con startService: " + e.getMessage());
            }

            ExoPlayer player = ensurePlayerInitialized(appContext);
            Uri mediaUri = resolveMediaUri(appContext, url, filePath);
            if (mediaUri == null) {
                Log.w(TAG, "No se pudo resolver URI para url=" + url + ", filePath=" + filePath);
                return;
            }

            fallbackDurationSec = durationSec > 0 ? durationSec : 0.0;

            MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
                .setTitle(title != null && !title.isEmpty() ? title : "Canción")
                .setArtist(artist != null && !artist.isEmpty() ? artist : "Artista Desconocido")
                .setAlbumTitle(album != null ? album : "")
                .setIsPlayable(true)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC);

            applyArtworkToMetadata(appContext, metaBuilder, coverUrl);

            Bundle extras = new Bundle();
            if (filePath != null) extras.putString("filePath", filePath);
            if (url != null) extras.putString("url", url);
            metaBuilder.setExtras(extras);

            MediaItem mediaItem = new MediaItem.Builder()
                .setMediaId(filePath != null && !filePath.isEmpty() ? filePath : mediaUri.toString())
                .setUri(mediaUri)
                .setMediaMetadata(metaBuilder.build())
                .build();

            player.setMediaItem(mediaItem);
            player.prepare();
            player.setPlayWhenReady(autoPlay);
            if (autoPlay) {
                player.play();
                startProgressLoop();
            }
        });
    }

    public static void play(@NonNull Context context) {
        final Context appContext = context.getApplicationContext();
        runOnMainThread(() -> {
            ExoPlayer player = ensurePlayerInitialized(appContext);
            if (player.getPlaybackState() == Player.STATE_IDLE && player.getMediaItemCount() > 0) {
                player.prepare();
            }
            player.setPlayWhenReady(true);
            player.play();
            startProgressLoop();
        });
    }

    public static void pause(@NonNull Context context) {
        final Context appContext = context.getApplicationContext();
        runOnMainThread(() -> {
            ExoPlayer player = ensurePlayerInitialized(appContext);
            player.setPlayWhenReady(false);
            player.pause();
            stopProgressLoop();
        });
    }

    public static void seekTo(@NonNull Context context, double positionSeconds) {
        final Context appContext = context.getApplicationContext();
        runOnMainThread(() -> {
            ExoPlayer player = ensurePlayerInitialized(appContext);
            long posMs = Math.max(0L, Math.round(positionSeconds * 1000.0));
            player.seekTo(posMs);
            notifyProgressInternal();
        });
    }

    public static void setVolume(@NonNull Context context, float volume) {
        final Context appContext = context.getApplicationContext();
        runOnMainThread(() -> {
            ExoPlayer player = ensurePlayerInitialized(appContext);
            float clamped = Math.max(0.0f, Math.min(1.0f, volume));
            player.setVolume(clamped);
        });
    }

    public static void setEqualizerBands(@NonNull Context context, @NonNull float[] gainsDb) {
        final Context appContext = context.getApplicationContext();
        runOnMainThread(() -> {
            ensurePlayerInitialized(appContext);
            float[] copy = new float[REACT_EQ_FREQUENCIES_HZ.length];
            for (int i = 0; i < copy.length; i++) {
                float val = i < gainsDb.length ? gainsDb[i] : 0.0f;
                copy[i] = Math.max(-12.0f, Math.min(12.0f, val));
            }
            currentEqGainsDb = copy;
            applyEqualizerGainsInternal();
        });
    }

    private static synchronized void bindEqualizerToSession(int audioSessionId) {
        if (audioSessionId == C.AUDIO_SESSION_ID_UNSET || audioSessionId <= 0) {
            return;
        }
        if (hardwareEqualizer != null && boundAudioSessionId == audioSessionId) {
            applyEqualizerGainsInternal();
            return;
        }

        releaseEqualizerInternal();

        try {
            hardwareEqualizer = new Equalizer(0, audioSessionId);
            hardwareEqualizer.setEnabled(true);
            boundAudioSessionId = audioSessionId;
            applyEqualizerGainsInternal();
        } catch (Exception e) {
            Log.w(TAG, "No se pudo inicializar Equalizer nativo: " + e.getMessage());
            hardwareEqualizer = null;
            boundAudioSessionId = C.AUDIO_SESSION_ID_UNSET;
        }
    }

    private static synchronized void applyEqualizerGainsInternal() {
        if (hardwareEqualizer == null) return;
        try {
            short numBands = hardwareEqualizer.getNumberOfBands();
            short[] levelRange = hardwareEqualizer.getBandLevelRange();
            if (numBands <= 0 || levelRange == null || levelRange.length < 2) return;

            short minLevelMb = levelRange[0];
            short maxLevelMb = levelRange[1];

            for (short b = 0; b < numBands; b++) {
                int centerFreqMilliHz = hardwareEqualizer.getCenterFreq(b);
                double centerFreqHz = centerFreqMilliHz / 1000.0;
                float interpolatedDb = interpolateEqGainDb(centerFreqHz, currentEqGainsDb);
                int targetMillibels = Math.round(interpolatedDb * 100.0f);
                short clampedLevel = (short) Math.max(minLevelMb, Math.min(maxLevelMb, targetMillibels));
                hardwareEqualizer.setBandLevel(b, clampedLevel);
            }
        } catch (Exception e) {
            Log.w(TAG, "Error aplicando bandas al Equalizer nativo: " + e.getMessage());
        }
    }

    /**
     * Interpola las 10 bandas de frecuencia de React ([60..16000] Hz) a la frecuencia central
     * de cada banda física del chip de audio del dispositivo Motorola.
     */
    private static float interpolateEqGainDb(double freqHz, float[] gainsDb) {
        if (gainsDb == null || gainsDb.length == 0) return 0.0f;
        int n = Math.min(REACT_EQ_FREQUENCIES_HZ.length, gainsDb.length);
        if (freqHz <= REACT_EQ_FREQUENCIES_HZ[0]) {
            return gainsDb[0];
        }
        if (freqHz >= REACT_EQ_FREQUENCIES_HZ[n - 1]) {
            return gainsDb[n - 1];
        }
        for (int i = 0; i < n - 1; i++) {
            double fLow = REACT_EQ_FREQUENCIES_HZ[i];
            double fHigh = REACT_EQ_FREQUENCIES_HZ[i + 1];
            if (freqHz >= fLow && freqHz <= fHigh) {
                double logLow = Math.log(fLow);
                double logHigh = Math.log(fHigh);
                double logCur = Math.log(Math.max(1.0, freqHz));
                double t = (logHigh > logLow) ? (logCur - logLow) / (logHigh - logLow) : 0.0;
                return (float) (gainsDb[i] + t * (gainsDb[i + 1] - gainsDb[i]));
            }
        }
        return 0.0f;
    }

    private static synchronized void releaseEqualizerInternal() {
        if (hardwareEqualizer != null) {
            try {
                hardwareEqualizer.release();
            } catch (Exception ignored) {
            }
            hardwareEqualizer = null;
        }
        boundAudioSessionId = C.AUDIO_SESSION_ID_UNSET;
    }

    @Nullable
    public static Uri resolveMediaUri(@NonNull Context context, @Nullable String url, @Nullable String filePath) {
        // 1. Intentar resolver primero desde la ruta física en la bóveda (Directory.Data -> getFilesDir())
        if (filePath != null && !filePath.trim().isEmpty()) {
            File resolvedFile = resolveLocalVaultFile(context, filePath.trim());
            if (resolvedFile != null && resolvedFile.exists()) {
                return Uri.fromFile(resolvedFile);
            }
        }

        if (url == null || url.trim().isEmpty()) {
            return null;
        }

        String cleanUrl = url.trim();

        // 2. Resolver URLs de Capacitor WebView (https://localhost/_capacitor_file_/...)
        int capPrefixIdx = cleanUrl.indexOf("/_capacitor_file_/");
        if (capPrefixIdx >= 0) {
            String rawLocalPath = cleanUrl.substring(capPrefixIdx + "/_capacitor_file_".length());
            int queryIdx = rawLocalPath.indexOf('?');
            if (queryIdx >= 0) {
                rawLocalPath = rawLocalPath.substring(0, queryIdx);
            }
            String decodedPath = Uri.decode(rawLocalPath);
            File capFile = new File(decodedPath);
            if (capFile.exists()) {
                return Uri.fromFile(capFile);
            }
        }

        // 3. Resolver esquema interno vault://
        if (cleanUrl.startsWith("vault://")) {
            String rel = cleanUrl.substring("vault://".length());
            File vaultFile = resolveLocalVaultFile(context, rel);
            if (vaultFile != null && vaultFile.exists()) {
                return Uri.fromFile(vaultFile);
            }
        }

        // 4. Resolver esquema file://
        if (cleanUrl.startsWith("file://")) {
            Uri parsed = Uri.parse(cleanUrl);
            if (parsed.getPath() != null) {
                File f = new File(Uri.decode(parsed.getPath()));
                if (f.exists()) {
                    return Uri.fromFile(f);
                }
            }
            return parsed;
        }

        return Uri.parse(cleanUrl);
    }

    @Nullable
    private static File resolveLocalVaultFile(@NonNull Context context, @NonNull String rawPath) {
        String normalized = rawPath.replace('\\', '/').trim();
        if (normalized.startsWith("file://")) {
            Uri u = Uri.parse(normalized);
            if (u.getPath() != null) {
                normalized = Uri.decode(u.getPath());
            }
        }

        File direct = new File(normalized);
        if (direct.isAbsolute() && direct.exists()) {
            return direct;
        }

        String relPath = normalized.replaceAll("^/+", "");
        File inFilesDir = new File(context.getFilesDir(), relPath);
        if (inFilesDir.exists()) {
            return inFilesDir;
        }

        if (!relPath.startsWith("app_vault/")) {
            File inVaultDir = new File(new File(context.getFilesDir(), "app_vault"), relPath);
            if (inVaultDir.exists()) {
                return inVaultDir;
            }
        }

        File inCacheDir = new File(context.getCacheDir(), relPath);
        if (inCacheDir.exists()) {
            return inCacheDir;
        }

        return inFilesDir;
    }

    private static void applyArtworkToMetadata(
        @NonNull Context context,
        @NonNull MediaMetadata.Builder builder,
        @Nullable String coverUrl
    ) {
        if (coverUrl == null || coverUrl.trim().isEmpty()) {
            return;
        }
        String trimmed = coverUrl.trim();
        try {
            if (trimmed.startsWith("data:image")) {
                int commaIdx = trimmed.indexOf(',');
                if (commaIdx > 0) {
                    String base64Part = trimmed.substring(commaIdx + 1);
                    byte[] data = Base64.decode(base64Part, Base64.DEFAULT);
                    if (data != null && data.length > 0) {
                        builder.setArtworkData(data, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
                    }
                }
                return;
            }

            Uri resolvedUri = resolveMediaUri(context, trimmed, null);
            if (resolvedUri != null) {
                builder.setArtworkUri(resolvedUri);
                if ("file".equalsIgnoreCase(resolvedUri.getScheme()) && resolvedUri.getPath() != null) {
                    File imgFile = new File(resolvedUri.getPath());
                    if (imgFile.exists() && imgFile.length() > 0 && imgFile.length() <= 5 * 1024 * 1024) {
                        byte[] bytes = readFileBytes(imgFile);
                        if (bytes != null && bytes.length > 0) {
                            builder.setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "No se pudo cargar carátula en MediaMetadata: " + e.getMessage());
        }
    }

    @Nullable
    private static byte[] readFileBytes(@NonNull File file) {
        try (InputStream is = new FileInputStream(file);
             ByteArrayOutputStream bos = new ByteArrayOutputStream((int) file.length())) {
            byte[] buf = new byte[8192];
            int r;
            while ((r = is.read(buf)) != -1) {
                bos.write(buf, 0, r);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ExoPlayer player = ensurePlayerInitialized(getApplicationContext());

        // ForwardingPlayer para habilitar siempre los botones Siguiente / Anterior en
        // pantalla de bloqueo, cortina de notificaciones y auriculares Bluetooth.
        ForwardingPlayer sessionPlayer = new ForwardingPlayer(player) {
            @NonNull
            @Override
            public Player.Commands getAvailableCommands() {
                return super.getAvailableCommands()
                    .buildUpon()
                    .add(Player.COMMAND_SEEK_TO_NEXT)
                    .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                    .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .add(Player.COMMAND_PLAY_PAUSE)
                    .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
                    .build();
            }

            @Override
            public boolean isCommandAvailable(int command) {
                if (command == Player.COMMAND_SEEK_TO_NEXT ||
                    command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ||
                    command == Player.COMMAND_SEEK_TO_PREVIOUS ||
                    command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM ||
                    command == Player.COMMAND_PLAY_PAUSE ||
                    command == Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM) {
                    return true;
                }
                return super.isCommandAvailable(command);
            }

            @Override
            public void seekToNext() {
                if (eventListener != null) {
                    eventListener.onRemoteCommand("next", null);
                }
            }

            @Override
            public void seekToNextMediaItem() {
                if (eventListener != null) {
                    eventListener.onRemoteCommand("next", null);
                }
            }

            @Override
            public void seekToPrevious() {
                if (eventListener != null) {
                    eventListener.onRemoteCommand("previous", null);
                }
            }

            @Override
            public void seekToPreviousMediaItem() {
                if (eventListener != null) {
                    eventListener.onRemoteCommand("previous", null);
                }
            }

            @Override
            public void seekTo(long positionMs) {
                super.seekTo(positionMs);
                if (eventListener != null) {
                    eventListener.onRemoteCommand("seekTo", positionMs / 1000.0);
                }
            }
        };

        Intent openAppIntent = new Intent(this, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent sessionActivityPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            pendingFlags
        );

        mediaSession = new MediaSession.Builder(this, sessionPlayer)
            .setSessionActivity(sessionActivityPendingIntent)
            .build();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        Player player = mediaSession != null ? mediaSession.getPlayer() : exoPlayer;
        if (player == null || !player.getPlayWhenReady() || player.getMediaItemCount() == 0) {
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        stopProgressLoop();
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        releaseEqualizerInternal();
        if (exoPlayer != null) {
            exoPlayer.release();
            exoPlayer = null;
        }
        super.onDestroy();
    }
}
