# AGENTS.md - Reproductor de Música

## 🚀 Key Commands
- **Run in development mode (with hot reloading):** `npm run dev`
- **Build for production:** `npm run build`
- **Package and update compiled app:** `npm run dist`

## 📂 Directory Structure
- `Aplicacion_Compilada/`: Executables for end users (installer, portable version, and shortcut).
- `canciones_organizadas/`: Root folder for music files. Each top-level folder is treated as an album, and subfolders are supported recursively.
- `scripts/`: Utility scripts (desktop shortcut generator, icon generator, release packager).
- `src/main/`: Electron main process (window, scanner, adaptive edge detection, and global hotkeys).
- `src/renderer/`: React app (UI components, player controls, and mini panel).
- `_archivado/`: Historical or archived experiment files.

## ⚙️ Hotkey Customization
- Hotkey mappings are configured in `src/main/hotkeys.js`. Example:
  ```javascript
  const HOTKEY_CONFIG = {
    next: 'Ctrl+Right',        // Next track
    previous: 'Ctrl+Left',     // Previous track
    togglePanel: 'Ctrl+Shift+M' // Show/hide side panel
  }
  ```

## 🎯 Key Points for Agents
1. **Music Organization**:
   - Place music files in `canciones_organizadas/`. Each top-level folder is an album, and subfolders are supported recursively.
   - Album covers are automatically extracted from embedded ID3 tags or folder images (`cover.jpg`, `folder.png`, etc.).
2. **UI Components**:
   - `MiniPanel.jsx`: Vertical side panel with quick navigation and hover-activated marker.
   - `Player.jsx`: Bottom bar with playback controls and interactive timeline.
3. **IPC & State**:
   - `PlayerContext.jsx`: Manages global state and synchronization between windows via Electron IPC.

## 🛠️ Framework & Toolchain
- Built with **Electron**, **React 18**, **Vite**, and **music-metadata**.
- Config files: `electron.vite.config.mjs`, `package.json`.
