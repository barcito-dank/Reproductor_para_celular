# AGENTS.md - Reproductor para Celular (Mobile-First Capacitor + Android)

## 🧠 Memoria Externa en Notion (Protocolo Automático para Agentes IA)
- **Página de Memoria Externa en Notion**: `Reproductor para celular` (Dentro de `Proyectos`)
  - **Notion Page ID**: `4164987b-e5be-81a5-8ca9-d97e33076c94`
  - **Notion URL**: https://app.notion.com/p/4164987be5be81a58ca9d97e33076c94
- **Repositorio GitHub**: https://github.com/barcito-dank/Reproductor_para_celular
- **Instrucciones Obligatorias de Memoria Externa (No pedir explicación al usuario)**:
  1. **Al iniciar sesión o retomar el desarrollo**: Consulta la página `4164987b-e5be-81a5-8ca9-d97e33076c94` mediante el MCP de Notion (`notion-fetch`) para revisar el estado del backlog, decisiones arquitectónicas recientes y notas de pruebas en el Motorola.
  2. **Al finalizar cambios significativos o nuevos commits**: Actualiza la página `4164987b-e5be-81a5-8ca9-d97e33076c94` (`notion-update-page`) registrando:
     - Decisiones arquitectónicas (cambios en tablas SQLite `tracks`/`albums`/`album_tracks`, contratos del plugin `NativeAudioPlayer` o `AndroidManifest.xml`).
     - Soluciones a bugs detectados en Android / Motorola (Doze Mode, AudioFocus, WebView, permisos).
     - Actualización de casillas `[x]` en **📌 Estado del Proyecto & Próximos Pasos** y el nuevo hash de commit en **📜 Historial de Cambios y Commits**.

## 🚀 Key Commands
- **Run in web development mode (with hot reloading):** `npm run dev`
- **Build production web assets (`dist-web/`):** `npm run build`
- **Typecheck TypeScript (`0` errors):** `npm run typecheck`
- **Run automated unit & relational vault tests:** `npm test`
- **Build & sync web assets + plugins with Android:** `npm run cap:sync`
- **Open native Android project in Android Studio:** `npm run cap:open`
- **Build & run directly on connected Motorola / Android device:** `npm run android:run`

## 📂 Directory Structure
- `android/`: Native Android platform (Capacitor 6 + AndroidX Media3 `ExoPlayer` + `MediaSessionService` + hardware `Equalizer`).
  - `android/app/src/main/java/com/reproductor/musica/MediaPlaybackService.java`: Background `MediaSessionService` with `C.WAKE_MODE_LOCAL`, `AudioAttributes` (`USAGE_MEDIA`), lock-screen/notification controls, Bluetooth headset support, and 10-band to hardware band EQ interpolation.
  - `android/app/src/main/java/com/reproductor/musica/NativeAudioPlayerPlugin.java`: Capacitor native plugin (`@CapacitorPlugin(name = "NativeAudioPlayer")`).
- `src/renderer/src/`: React 18 + TypeScript + Vite frontend.
  - `services/StorageVaultService.ts`: **Single Physical Store + Virtual Inode Index** engine powered by `@capacitor-community/sqlite` and `@capacitor/filesystem`.
  - `services/metadataExtractor.ts`: Pure browser/mobile ID3/MP4/FLAC/Vorbis tag & cover extractor (`music-metadata` over `Uint8Array`) with SHA-256 deduplication.
  - `services/NativeAudioBridge.ts`: TypeScript bridge for `NativeAudioPlayer`, `@capacitor/app` lifecycle (`appStateChange`, `backButton`), and media session reconciliation.
  - `services/mobileBridge.ts`: Mobile implementation of `window.electronAPI` so React components work seamlessly across Android and Web.
  - `components/`: Mobile-First Touch UI (`BottomNavBar.jsx`, `Player.jsx` with `MiniPlayer` + swipeable `NowPlayingSheet`, `AlbumView.jsx` with Action Sheet & Bookmark sheets, `Sidebar.jsx`, `LyricsDock.jsx`, `SpotlightSearch.jsx`, `SettingsModal.jsx`).
- `src/shared/`: Shared domain logic (`types.ts`, `security.ts`, `lyricsParser.ts`, `shuffle.ts`).
- `test/`: Vitest automated test suites (`vault.test.ts`, `lyrics.test.ts`, `security.test.ts`, `shuffle.test.ts`).

## 🎯 Key Architectural Points for Agents
1. **Single Physical Store + Virtual Inode Index (Zero Duplication on Android FAT32/ext4)**:
   - Physical audio/video files are stored **once** in `Directory.Data/app_vault/tracks/<track_uuid>.<ext>`.
   - Covers are deduplicated by hash in `Directory.Cache/.covers/<sha256>.jpg`.
   - Relational SQLite tables (`tracks`, `albums`, `album_tracks`) map tracks to multiple albums (`M:N`) with **0 extra bytes** of storage.
   - Deleting a track from an album removes only its `album_tracks` row; the physical file in `app_vault/tracks/` is deleted **only** when its reference count reaches `0`.
2. **Continuous Background Playback on Motorola (`MediaPlaybackService`)**:
   - Uses AndroidX Media3 (`ExoPlayer` + `MediaSessionService` + `C.WAKE_MODE_LOCAL`) declared with `foregroundServiceType="mediaPlayback"` so playback never freezes when the Motorola screen is turned off.
   - `ForwardingPlayer` enables Previous/Next/Play/Pause/Seek controls on the Android lock screen, notification shade, and Bluetooth earbuds.
3. **Mobile-First Touch Ergonomics**:
   - Safe-area insets (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`), minimum `48x48px` touch targets, haptic feedback (`@capacitor/haptics`), and hardware back button handling (`@capacitor/app`).

## 🛠️ Framework & Toolchain
- Built with **Capacitor 6**, **AndroidX Media3 (1.3.1)**, **React 18**, **TypeScript**, **Vite 5**, **SQLite**, and **music-metadata**.
- Config files: `capacitor.config.ts`, `vite.config.ts`, `tsconfig.json`, `vitest.config.ts`, `package.json`.
