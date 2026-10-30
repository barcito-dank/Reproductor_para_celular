# 🎵 Reproductor de Música Personal (Desktop App)

Aplicación de escritorio moderna, minimalista y con tema oscuro para reproducir música local, construida con **Electron**, **React 18**, **Vite** y **music-metadata**.

---

## 🚀 Características Principales

1. **Interfaz Moderna & Dark Theme**:
   - Geometría con bordes redondeados y tipografía pulida.
   - Controles completos de reproducción: Reproducir/Pausa, Siguiente, Anterior, Modo Aleatorio (Shuffle), y Bucle (Loop: desactivado / álbum completo / una sola canción).
   - Barra de progreso interactiva (timeline con búsqueda por clic) y control de volumen deslizante.

2. **Organización Dinámica por Carpetas**:
   - Directorio raíz local: `canciones_organizadas/`.
   - Cada carpeta de primer nivel es interpretada como un **Álbum**.
   - **Soporte recursivo para subcarpetas** (por ejemplo, carpetas de CDs, bonus tracks o ediciones especiales dentro del álbum).
   - Extracción automática de portadas (etiquetas ID3 embebidas o imágenes en la carpeta: `cover.jpg`, `folder.png`, etc.) y metadatos (título, artista, duración).

3. **Panel Lateral de Navegación Rápida (Mini Panel)**:
   - Ventana flotante vertical que abarca los extremos de la pantalla de arriba a abajo.
   - **Marcador chico activado por hover**: Al acercar el ratón a cualquier parte del borde derecho de la pantalla, aparece suavemente un pequeño marcador en la parte superior derecha (~20% del alto) con icono musical y flecha.
   - **Opciones de Comportamiento en Cabecera**:
     - 📌 **Fijar (Siempre visible)**: Mantiene la barra lateral abierta permanentemente sin cerrarse.
     - ⏱️ **Ocultación automática (Auto-hide al tocar otra cosa)**: Oculta la barra lateral automáticamente en cuanto haces clic en otra aplicación o fuera de la ventana.
   - Lista vertical con miniaturas y títulos para cambiar de canción al instante.
   - Sincronización bidireccional en tiempo real entre ventanas vía IPC de Electron.

4. **Atajos de Teclado Globales (Configurables)**:
   - Configurados en `src/main/hotkeys.js`:
     - **Siguiente canción**: `Ctrl + Flecha Derecha`
     - **Canción anterior**: `Ctrl + Flecha Izquierda`
     - **Desplegar / Ocultar panel lateral**: `Ctrl + Shift + M`

---

## 📂 Estructura del Proyecto

```text
Reproductor_de_musica/
├── canciones_organizadas/          # Carpeta donde colocas tu música
│   └── Sintonia Urbana/            # Ejemplo de álbum
│       ├── 01 - Melodia Nocturna.wav
│       ├── 02 - Ritmo de la Ciudad.wav
│       └── Bonus Tracks/           # Subcarpeta soportada recursivamente
│           └── 03 - Acordes en Lluvia.wav
├── src/
│   ├── main/
│   │   ├── index.js                # Ventana principal, panel lateral e IPC
│   │   ├── scanner.js              # Escaneo recursivo y metadatos de audio
│   │   └── hotkeys.js              # Atajos de teclado globales configurables
│   ├── preload/
│   │   └── index.js                # Bridge seguro contextBridge (IPC)
│   └── renderer/
│       ├── index.html              # HTML base
│       └── src/
│           ├── main.jsx            # Punto de entrada React
│           ├── App.jsx             # Layout y selector de vista principal / mini panel
│           ├── App.css             # Estilos completos Dark Theme
│           ├── context/
│           │   └── PlayerContext.jsx # Gestión de estado global y sincronización
│           └── components/
│               ├── Sidebar.jsx     # Explorador y buscador de álbumes
│               ├── AlbumView.jsx   # Vista detallada de pistas del álbum
│               ├── Player.jsx      # Barra inferior con controles y timeline
│               └── MiniPanel.jsx   # Panel lateral desplegable
├── electron.vite.config.mjs         # Configuración de compilación Vite + Electron
├── package.json                    # Dependencias y scripts del proyecto
└── README.md
```

---

## 🛠️ Comandos para Ejecutar

### Modo Desarrollo (con Hot Reloading):
```bash
npm run dev
```

### Compilar para Producción:
```bash
npm run build
```

---

## ⚙️ Personalización de Atajos

Para cambiar las combinaciones de teclas, edita `src/main/hotkeys.js`:
```javascript
const HOTKEY_CONFIG = {
  next: 'Ctrl+Right',        // Siguiente pista
  previous: 'Ctrl+Left',     // Pista anterior
  togglePanel: 'Ctrl+Shift+M'// Mostrar/ocultar panel lateral
}
```
Puedes usar modificadores como `Ctrl`, `Alt`, `Shift`, `Super` o teclas multimedia como `MediaNextTrack`.
