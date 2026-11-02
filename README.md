# 🎵 Reproductor de Música Personal (Desktop App)

Aplicación de escritorio moderna, minimalista y de alto rendimiento para reproducir y organizar tu biblioteca musical local, construida con **Electron**, **React 18**, **Vite** y **music-metadata**.

---

## 🚀 Características Principales

### 1. 🗂️ Reorganización y Drag & Drop Inteligente de Álbumes
- **Arrastre y Soltado Fluido (Pointer Events)**: Reorganiza carpetas y álbumes en el disco arrastrando directamente desde el tirador dedicado (`⋮⋮`) o desde la propia tarjeta del álbum.
- **Zona de Soltado a Nivel Principal**: Arrastra cualquier álbum hacia la zona superior (`root-drop-zone`) o sobre la colección "Todos" para moverlo fuera de subcarpetas al nivel raíz.
- **Auto-despliegue al Sobrevolar**: Mantener un álbum arrastrado sobre una carpeta cerrada la despliega automáticamente tras 500 ms.
- **Alternativas Accesibles sin Arrastrar**:
  - **📁 Menú Contextual ➜ Mover a...**: Selector modal con barra de búsqueda para mover cualquier álbum a otra carpeta o al nivel principal en un clic.
  - **⬆️ Sacar a nivel raíz**: Botón rápido en clic derecho si el álbum se encuentra dentro de una subcarpeta.
  - **✏️ Renombrar y 🗑️ Eliminar**: Modificación y envío seguro de carpetas y pistas a la Papelera de reciclaje.

### 2. 🎨 Interfaz Moderna, Temas y Visualizador de Audio
- **Soporte de Temas**: Modos **Oscuro (Dark)** y **Claro (Light)** sincronizados en tiempo real en todas las ventanas.
- **Ecualizador Visual (Audio Visualizer)**: Animación reactiva y visualizador de audio en tiempo real integrado en la reproducción.
- **Fondo Ambiental Dinámico**: Glow suave que refleja la portada de la canción o álbum activo sin impactar el rendimiento de renderizado.
- **Controles Completos**: Reproducción/Pausa, Pista Siguiente/Anterior, Aleatorio (Shuffle inteligente) y Bucle (Loop: desactivado, álbum completo o repetición de pista).

### 3. ✨ Colección Automática "Todos" y Marcadores Multi-Álbum
- **Colección Virtual "Todos"**: Agrupa automáticamente todas las canciones de tu biblioteca en una sola lista unificada.
- **Marcadores (Bookmarks) de Canciones**: Identifica en cuántos álbumes se encuentra una pista y permite clonarla/asignarla a otros álbumes fácilmente.
- **Menú Contextual de Canciones**: Opciones para abrir la ubicación del archivo en el explorador de Windows, consultar propiedades técnicas (frecuencia de muestreo, tasa de bits, códec, tamaño) y eliminar pistas.

### 4. 🔍 Buscador Global Spotlight (`Ctrl+K` / `Ctrl+F`)
- Modal de búsqueda rápida en toda la biblioteca por título, artista o álbum.
- Navegación ágil mediante teclado para saltar a cualquier canción o álbum instantáneamente.

### 5. 📱 Panel Lateral de Navegación Rápida (Mini Panel)
- Ventana vertical auxiliar con lista compacta de pistas y portadas.
- **Activación por Hover en el Borde**: Pequeño marcador sutil que aparece en el margen derecho de la pantalla al acercar el cursor.
- **Modos de Comportamiento**:
  - 📌 **Fijar (Siempre visible)**: Permanece en pantalla sin ocultarse.
  - ⏱️ **Auto-hide**: Se retrae automáticamente al interactuar fuera de la ventana.
- Sincronización bidireccional instantánea mediante IPC entre la ventana principal y el mini panel.

### 6. ⌨️ Atajos de Teclado Globales y de Ventana
- **Globales** (funcionan incluso con la aplicación en segundo plano, configurables en `src/main/hotkeys.js`):
  - `Ctrl + Flecha Derecha`: Siguiente pista.
  - `Ctrl + Flecha Izquierda`: Pista anterior.
  - `Ctrl + Shift + M`: Mostrar / ocultar panel lateral rápido.
- **En la Ventana Principal**:
  - `Espacio`: Reproducir / Pausar.
  - `Ctrl + K` / `Ctrl + F`: Abrir Buscador Spotlight.
  - `Flecha Arriba` / `Flecha Abajo`: Subir / Bajar volumen.

---

## 📂 Estructura del Proyecto

```text
Reproductor_de_musica/
├── Aplicacion_Compilada/          # Ejecutables compilados para usuarios finales (Instalador y Portable)
├── canciones_organizadas/          # Carpeta raíz de música (cada carpeta es un álbum)
├── scripts/                        # Scripts de utilidades (accesos directos, iconos, release)
├── src/
│   ├── main/
│   │   ├── index.js                # Ventana principal, panel lateral, IPC y operaciones de disco
│   │   ├── scanner.js              # Escaneo recursivo, metadatos y modelo de canciones
│   │   └── hotkeys.js              # Atajos de teclado globales
│   ├── preload/
│   │   └── index.js                # Puente seguro contextBridge (IPC)
│   └── renderer/
│       ├── index.html              # HTML base
│       └── src/
│           ├── main.jsx            # Punto de entrada React
│           ├── App.jsx             # Shell de la aplicación y layouts
│           ├── App.css             # Sistema de diseño y hojas de estilo (Dark/Light)
│           ├── context/
│           │   └── PlayerContext.jsx # Estado global, reproducción de audio e IPC
│           ├── components/
│           │   ├── Sidebar.jsx     # Explorador de biblioteca, Drag & Drop y modales
│           │   ├── AlbumView.jsx   # Lista de pistas, marcadores y acciones de canción
│           │   ├── Player.jsx      # Barra de controles y timeline interactivo
│           │   ├── MiniPanel.jsx   # Panel lateral rápido flotante
│           │   ├── SpotlightSearch.jsx # Buscador global modal (Ctrl+K)
│           │   ├── AudioVisualizer.jsx # Visualizador de barras de frecuencia
│           │   └── ToastNotification.jsx # Avisos flotantes no intrusivos
│           └── utils/
│               └── trackUtils.js   # Utilidades de comparación y nombrado de pistas
├── electron.vite.config.mjs         # Configuración Vite + Electron
├── package.json                    # Dependencias y scripts npm
└── README.md                       # Documentación del proyecto
```

---

## 🛠️ Comandos del Proyecto

### Modo Desarrollo (con Hot Reloading):
```bash
npm run dev
```

### Compilar para Producción:
```bash
npm run build
```

### Empaquetar Distribución (.exe instalador y portable):
```bash
npm run dist
```
*Genera los instaladores y actualiza la carpeta `Aplicacion_Compilada/`.*

### Generar Acceso Directo en el Escritorio:
```bash
npm run shortcut:desktop
```

---

## ⚙️ Personalización de Atajos Globales

Para modificar las combinaciones de teclas globales, edita `src/main/hotkeys.js`:

```javascript
const HOTKEY_CONFIG = {
  next: 'Ctrl+Right',        // Siguiente pista
  previous: 'Ctrl+Left',     // Pista anterior
  togglePanel: 'Ctrl+Shift+M'// Mostrar/ocultar panel lateral
}
```
*Puedes usar modificadores como `Ctrl`, `Alt`, `Shift`, `Super` o teclas multimedia del teclado.*
