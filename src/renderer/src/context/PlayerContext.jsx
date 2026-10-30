import { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react'

const PlayerContext = createContext(null)
const PlayerTimeContext = createContext({ currentTime: 0 })

// Helper para encontrar el primer álbum reproducible en la jerarquía
function findFirstAlbum(nodes) {
  if (!nodes || !Array.isArray(nodes)) return null
  for (const node of nodes) {
    if (node.type === 'album') return node
    if (node.children && Array.isArray(node.children)) {
      const found = findFirstAlbum(node.children)
      if (found) return found
    }
  }
  return null
}

// Helper para aplanar todos los álbumes del árbol (optimizado con recorrido sin allocs masivas)
function getAllAlbums(nodes) {
  if (!nodes || !Array.isArray(nodes)) return []
  const list = []
  function traverse(items) {
    for (const node of items) {
      if (node.type === 'album') list.push(node)
      if (node.children && Array.isArray(node.children)) {
        traverse(node.children)
      }
    }
  }
  traverse(nodes)
  return list
}

export function PlayerProvider({ children, isMiniPanel = false }) {
  const audioRef = useRef(new Audio())
  const [library, setLibrary] = useState([]) // Árbol jerárquico de carpetas y álbumes
  const [currentTrack, setCurrentTrack] = useState(null)
  const [currentAlbum, setCurrentAlbum] = useState(null)
  const [playlist, setPlaylist] = useState([]) // Cola de reproducción
  const [playlistIndex, setPlaylistIndex] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [shuffle, setShuffle] = useState(false)
  const [loop, setLoop] = useState('none') // 'none' | 'all' | 'one'
  const [isLoading, setIsLoading] = useState(true)
  const [selectedAlbum, setSelectedAlbum] = useState(null)
  const [musicDirectory, setMusicDirectory] = useState(() => (
    window.localStorage.getItem('musicPlayerDirectory') || ''
  ))

  // allAlbums memoizado estrictamente basado en library (se calcula una sola vez tras escanear)
  const allAlbums = useMemo(() => getAllAlbums(library), [library])

  const lastTimeSyncRef = useRef(0)
  const lastSentPlaylistRef = useRef(null)

  // Cargar biblioteca de música (se ejecuta estrictamente una sola vez)
  const loadLibrary = useCallback(async (directory = window.localStorage.getItem('musicPlayerDirectory') || undefined) => {
    setIsLoading(true)
    try {
      const tree = await window.electronAPI.scanMusic(directory)
      setLibrary(tree || [])
      // Seleccionar automáticamente el primer álbum sin recargar la biblioteca
      if (tree && tree.length > 0) {
        setSelectedAlbum(prev => prev || findFirstAlbum(tree))
      }
    } catch (err) {
      console.error('Error cargando biblioteca:', err)
    }
    setIsLoading(false)
  }, []) // Dependencias vacías: NUNCA se vuelve a ejecutar al seleccionar un álbum

  const updateMusicDirectory = useCallback(async (directory) => {
    window.localStorage.setItem('musicPlayerDirectory', directory)
    setMusicDirectory(directory)
    setSelectedAlbum(null)
    await loadLibrary(directory)
  }, [loadLibrary])

  const historyRef = useRef([])
  const futureRef = useRef([])

  // Web Audio API para análisis de espectro en tiempo real
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceNodeRef = useRef(null)

  const initAudioAnalyser = useCallback(() => {
    if (isMiniPanel) return null
    if (analyserRef.current) {
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(console.error)
      }
      return analyserRef.current
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return null
      const ctx = new AudioCtx()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 128 // 64 bandas de frecuencia de alta resolución
      analyser.smoothingTimeConstant = 0.60 // Respuesta rápida, enérgica y ágil al ritmo
      analyser.minDecibels = -75 // Mayor sensibilidad para que hasta los pasajes suaves se eleven
      analyser.maxDecibels = -15 // Rango superior con pegada y dinamismo visual

      const source = ctx.createMediaElementSource(audioRef.current)
      source.connect(analyser)
      analyser.connect(ctx.destination)

      audioContextRef.current = ctx
      analyserRef.current = analyser
      sourceNodeRef.current = source

      if (ctx.state === 'suspended') {
        ctx.resume().catch(console.error)
      }

      return analyser
    } catch (e) {
      console.warn('Web Audio API analyser init:', e.message)
      return analyserRef.current
    }
  }, [isMiniPanel])

  // Carga un archivo de audio en el elemento Audio y actualiza estados de reproducción
  const loadAndPlayTrack = useCallback((track, album = null, index = -1) => {
    const audio = audioRef.current

    // Inicializar o reanudar Web Audio Analyser
    initAudioAnalyser()

    setCurrentTrack(track)
    if (album) setCurrentAlbum(album)
    if (index >= 0) setPlaylistIndex(index)

    if (track.duration) {
      setDuration(track.duration)
    }
    setCurrentTime(0)
    lastTimeSyncRef.current = performance.now()
    window.electronAPI.sendPlayerTime?.(0)

    if (track.fileUrl) {
      audio.src = track.fileUrl
    } else {
      const normalized = track.path.replace(/\\/g, '/')
      const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
      audio.src = encodeURI(fileUrl).replace(/#/g, '%23')
    }

    audio.play().catch(err => console.error('Error reproduciendo audio:', err))
  }, [initAudioAnalyser])

  // Reproducir pista específica (selección manual)
  const playTrack = useCallback((track, album = null, newPlaylist = null, index = 0) => {
    if (newPlaylist) {
      setPlaylist(newPlaylist)
    }

    // Guardar la canción que estaba sonando en el historial
    if (currentTrack && currentTrack.id !== track.id) {
      historyRef.current.push({
        track: currentTrack,
        album: currentAlbum,
        playlistIndex: playlistIndex
      })
      if (historyRef.current.length > 200) historyRef.current.shift()
      futureRef.current = [] // Limpiar futuro al hacer una selección manual
    }

    loadAndPlayTrack(track, album, index)
  }, [currentTrack, currentAlbum, playlistIndex, loadAndPlayTrack])

  // Alternar reproducir/pausar
  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!currentTrack) return
    initAudioAnalyser()
    if (audio.paused) {
      audio.play().catch(console.error)
    } else {
      audio.pause()
    }
  }, [currentTrack, initAudioAnalyser])

  // Navegar a posición de tiempo (scrubbing)
  const seekTo = useCallback((time) => {
    if (audioRef.current && !isNaN(time)) {
      audioRef.current.currentTime = time
      setCurrentTime(time)
      lastTimeSyncRef.current = performance.now()
      window.electronAPI.sendPlayerTime?.(time)
    }
  }, [])

  // Control de volumen
  const setVolumeLevel = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v))
    setVolume(clamped)
    if (audioRef.current) {
      audioRef.current.volume = clamped
    }
  }, [])

  // Alternar modo aleatorio
  const toggleShuffle = useCallback(() => {
    setShuffle(prev => !prev)
  }, [])

  // Alternar bucle (none -> all -> one -> none)
  const toggleLoop = useCallback(() => {
    setLoop(prev => {
      if (prev === 'none') return 'all'
      if (prev === 'all') return 'one'
      return 'none'
    })
  }, [])

  // Siguiente canción
  const nextTrack = useCallback(() => {
    if (playlist.length === 0) return

    // Si habíamos retrocedido previamente, avanzar por las canciones que estaban en el futuro
    if (futureRef.current.length > 0) {
      const nextItem = futureRef.current.pop()
      if (currentTrack) {
        historyRef.current.push({
          track: currentTrack,
          album: currentAlbum,
          playlistIndex: playlistIndex
        })
        if (historyRef.current.length > 200) historyRef.current.shift()
      }
      loadAndPlayTrack(nextItem.track, nextItem.album || currentAlbum, nextItem.playlistIndex)
      return
    }

    let nextIndex = -1
    if (shuffle) {
      nextIndex = Math.floor(Math.random() * playlist.length)
      if (playlist.length > 1) {
        while (nextIndex === playlistIndex) {
          nextIndex = Math.floor(Math.random() * playlist.length)
        }
      }
    } else {
      nextIndex = playlistIndex + 1
      if (nextIndex >= playlist.length) {
        if (loop === 'all') {
          nextIndex = 0
        } else {
          return // Fin de lista
        }
      }
    }

    // Registrar en el historial de canciones escuchadas
    if (currentTrack) {
      historyRef.current.push({
        track: currentTrack,
        album: currentAlbum,
        playlistIndex: playlistIndex
      })
      if (historyRef.current.length > 200) historyRef.current.shift()
    }

    loadAndPlayTrack(playlist[nextIndex], currentAlbum, nextIndex)
  }, [playlist, playlistIndex, shuffle, loop, currentTrack, currentAlbum, loadAndPlayTrack])

  // Canción anterior: regresa fielmente por todas las canciones escuchadas previamente
  const previousTrack = useCallback(() => {
    if (playlist.length === 0) return

    // 1. Si hay canciones en el historial de reproducción, volver a la última escuchada
    if (historyRef.current.length > 0) {
      const prevItem = historyRef.current.pop()

      // Guardar la actual en el futuro por si el usuario vuelve a presionar "Siguiente"
      if (currentTrack) {
        futureRef.current.push({
          track: currentTrack,
          album: currentAlbum,
          playlistIndex: playlistIndex
        })
      }

      loadAndPlayTrack(prevItem.track, prevItem.album || currentAlbum, prevItem.playlistIndex)
      return
    }

    // 2. Si no hay historial y estamos en modo aleatorio: reiniciar pista actual
    if (shuffle) {
      if (audioRef.current) audioRef.current.currentTime = 0
      setCurrentTime(0)
      return
    }

    // 3. Si no hay historial en modo normal: ir al índice inmediatamente anterior
    let prevIndex = playlistIndex - 1
    if (prevIndex < 0) {
      if (loop === 'all') {
        prevIndex = playlist.length - 1
      } else {
        prevIndex = 0
      }
    }

    loadAndPlayTrack(playlist[prevIndex], currentAlbum, prevIndex)
  }, [playlist, playlistIndex, shuffle, loop, currentTrack, currentAlbum, loadAndPlayTrack])

  // Manejador de fin de pista
  const handleTrackEnd = useCallback(() => {
    if (loop === 'one') {
      audioRef.current.currentTime = 0
      audioRef.current.play().catch(console.error)
    } else {
      nextTrack()
    }
  }, [loop, nextTrack])

  // Reproducir álbum completo
  const playAlbum = useCallback((album, startIndex = 0) => {
    if (!album || !album.tracks || album.tracks.length === 0) return
    const tracks = [...album.tracks]
    setPlaylist(tracks)
    setPlaylistIndex(startIndex)
    setCurrentAlbum(album)
    playTrack(tracks[startIndex], album, tracks, startIndex)
  }, [playTrack])

  // Cargar biblioteca al montar en la ventana principal
  useEffect(() => {
    if (!isMiniPanel) {
      loadLibrary()
    }
  }, [isMiniPanel, loadLibrary])

  // Configurar listeners de eventos del objeto Audio
  useEffect(() => {
    const audio = audioRef.current
    audio.volume = volume

    const onTimeUpdate = () => {
      const t = audio.currentTime
      setCurrentTime(t)
      // Throttling de alta frecuencia de tiempo hacia Electron (~500ms) para evitar saturación de IPC
      const now = performance.now()
      if (now - lastTimeSyncRef.current >= 500) {
        lastTimeSyncRef.current = now
        window.electronAPI.sendPlayerTime?.(t)
      }
    }
    const onDurationChange = () => { if (audio.duration) setDuration(audio.duration) }
    const onLoadedMetadata = () => { if (audio.duration) setDuration(audio.duration) }
    const onEnded = () => handleTrackEnd()
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
    }
  }, [handleTrackEnd, volume])

  // Sincronizar estado con otras ventanas (Mini Panel) SOLO cuando cambia la pista o controles
  // Optimización de payload: la playlist completa solo se transfiere cuando realmente cambia la referencia
  useEffect(() => {
    if (!isMiniPanel && currentTrack) {
      const playlistChanged = lastSentPlaylistRef.current !== playlist
      if (playlistChanged) {
        lastSentPlaylistRef.current = playlist
      }

      window.electronAPI.sendPlayerState({
        currentTrack,
        currentAlbum,
        ...(playlistChanged ? { playlist } : {}),
        playlistIndex,
        isPlaying,
        currentTime: audioRef.current ? audioRef.current.currentTime : 0,
        duration,
        shuffle,
        loop,
        volume
      })
    }
  }, [isMiniPanel, currentTrack, currentAlbum, playlist, playlistIndex, isPlaying, duration, shuffle, loop, volume])

  // Cargar estado inicial si estamos en la ventana Mini Panel
  useEffect(() => {
    if (!isMiniPanel) return
    if (window.electronAPI.getInitialPlayerState) {
      window.electronAPI.getInitialPlayerState().then((state) => {
        if (!state) return
        if (state.currentTrack) setCurrentTrack(state.currentTrack)
        if (state.currentAlbum) setCurrentAlbum(state.currentAlbum)
        if (state.playlist) setPlaylist(state.playlist)
        if (typeof state.playlistIndex === 'number') setPlaylistIndex(state.playlistIndex)
        if (typeof state.isPlaying === 'boolean') setIsPlaying(state.isPlaying)
        if (typeof state.currentTime === 'number') setCurrentTime(state.currentTime)
        if (typeof state.duration === 'number') setDuration(state.duration)
        if (state.shuffle !== undefined) setShuffle(state.shuffle)
        if (state.loop !== undefined) setLoop(state.loop)
        if (typeof state.volume === 'number') setVolume(state.volume)
      }).catch(console.error)
    }
  }, [isMiniPanel])

  // Escuchar sincronización de estado y tiempo si estamos en la ventana Mini Panel
  useEffect(() => {
    if (!isMiniPanel) return
    let unsubState = null
    let unsubTime = null

    if (window.electronAPI.onPlayerStateSync) {
      unsubState = window.electronAPI.onPlayerStateSync((state) => {
        if (!state) return
        if (state.currentTrack !== undefined) setCurrentTrack(state.currentTrack)
        if (state.currentAlbum !== undefined) setCurrentAlbum(state.currentAlbum)
        if (state.playlist !== undefined) setPlaylist(state.playlist)
        if (state.playlistIndex !== undefined) setPlaylistIndex(state.playlistIndex)
        if (state.isPlaying !== undefined) setIsPlaying(state.isPlaying)
        if (typeof state.currentTime === 'number') setCurrentTime(state.currentTime)
        if (typeof state.duration === 'number') setDuration(state.duration)
        if (state.shuffle !== undefined) setShuffle(state.shuffle)
        if (state.loop !== undefined) setLoop(state.loop)
        if (typeof state.volume === 'number') {
          setVolume(state.volume)
        }
      })
    }

    if (window.electronAPI.onPlayerTimeSync) {
      unsubTime = window.electronAPI.onPlayerTimeSync((time) => {
        if (typeof time === 'number') {
          setCurrentTime(time)
        }
      })
    }

    return () => {
      if (unsubState) unsubState()
      if (unsubTime) unsubTime()
    }
  }, [isMiniPanel])

  // Escuchar comandos de hotkeys o de la ventana lateral
  useEffect(() => {
    if (isMiniPanel || !window.electronAPI.onPlayerCommand) return

    const unsubCommand = window.electronAPI.onPlayerCommand((command) => {
      if (typeof command === 'string' && command.startsWith('select-')) {
        const idx = parseInt(command.replace('select-', ''), 10)
        if (!isNaN(idx) && playlist[idx]) {
          setPlaylistIndex(idx)
          playTrack(playlist[idx], currentAlbum, playlist, idx)
        }
        return
      }

      if (typeof command === 'string' && command.startsWith('seek-')) {
        const time = parseFloat(command.replace('seek-', ''))
        if (!isNaN(time)) {
          seekTo(time)
        }
        return
      }

      if (typeof command === 'string' && command.startsWith('volume-')) {
        const v = parseFloat(command.replace('volume-', ''))
        if (!isNaN(v)) {
          setVolumeLevel(v)
        }
        return
      }

      switch (command) {
        case 'next': nextTrack(); break
        case 'previous': previousTrack(); break
        case 'toggle-play': togglePlay(); break
        case 'toggle-shuffle': toggleShuffle(); break
        case 'toggle-loop': toggleLoop(); break
        case 'volume-up':
          setVolumeLevel(Math.min(1, Math.round(((volume ?? 0.8) + 0.05) * 100) / 100))
          break
        case 'volume-down':
          setVolumeLevel(Math.max(0, Math.round(((volume ?? 0.8) - 0.05) * 100) / 100))
          break
        default: break
      }
    })
    return unsubCommand
  }, [isMiniPanel, playlist, currentAlbum, playTrack, seekTo, setVolumeLevel, nextTrack, previousTrack, togglePlay, toggleShuffle, toggleLoop, volume])

  // Contexto principal memoizado: solo cambia cuando cambian datos reales de pista, biblioteca o controles
  // currentTime NO está en estas dependencias, por lo que AlbumView, Sidebar, etc. no se re-renderizan
  const playerValue = useMemo(() => ({
    library,
    allAlbums,
    currentTrack,
    currentAlbum,
    playlist,
    playlistIndex,
    isPlaying,
    duration,
    volume,
    shuffle,
    loop,
    isLoading,
    selectedAlbum,
    setSelectedAlbum,
    musicDirectory,
    updateMusicDirectory,
    playTrack,
    togglePlay,
    nextTrack,
    previousTrack,
    seekTo,
    setVolumeLevel,
    toggleShuffle,
    toggleLoop,
    playAlbum,
    loadLibrary,
    analyserRef,
    initAudioAnalyser
  }), [
    library,
    allAlbums,
    currentTrack,
    currentAlbum,
    playlist,
    playlistIndex,
    isPlaying,
    duration,
    volume,
    shuffle,
    loop,
    isLoading,
    selectedAlbum,
    setSelectedAlbum,
    musicDirectory,
    updateMusicDirectory,
    playTrack,
    togglePlay,
    nextTrack,
    previousTrack,
    seekTo,
    setVolumeLevel,
    toggleShuffle,
    toggleLoop,
    playAlbum,
    loadLibrary,
    initAudioAnalyser
  ])

  // Contexto de tiempo de alta frecuencia: solo suscriben los componentes que dibujan el progreso
  const timeValue = useMemo(() => ({
    currentTime
  }), [currentTime])

  return (
    <PlayerContext.Provider value={playerValue}>
      <PlayerTimeContext.Provider value={timeValue}>
        {children}
      </PlayerTimeContext.Provider>
    </PlayerContext.Provider>
  )
}

export function usePlayer() {
  const context = useContext(PlayerContext)
  if (!context) {
    throw new Error('usePlayer debe usarse dentro de PlayerProvider')
  }
  return context
}

export function usePlayerTime() {
  const context = useContext(PlayerTimeContext)
  if (!context) {
    throw new Error('usePlayerTime debe usarse dentro de PlayerProvider')
  }
  return context
}
