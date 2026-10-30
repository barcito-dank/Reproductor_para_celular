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
  const [rawLibrary, setRawLibrary] = useState([]) // Árbol jerárquico original de carpetas y álbumes
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

  // allAlbums memoizado estrictamente basado en rawLibrary (se calcula una sola vez tras escanear)
  const allAlbums = useMemo(() => getAllAlbums(rawLibrary), [rawLibrary])

  // Álbum virtual "Todas" con todas las canciones de todos los álbumes
  const allTracksAlbum = useMemo(() => {
    if (!allAlbums || allAlbums.length === 0) return null
    const tracks = []
    const seenIds = new Set()
    let firstCover = null

    for (const album of allAlbums) {
      if (!album.tracks) continue
      for (const track of album.tracks) {
        if (!seenIds.has(track.id)) {
          seenIds.add(track.id)
          const cover = track.cover || album.cover || null
          if (!firstCover && cover) firstCover = cover
          tracks.push({
            ...track,
            cover,
            albumName: album.name
          })
        }
      }
    }

    if (tracks.length === 0) return null

    return {
      id: '__all_tracks__',
      type: 'album',
      isAllTracks: true,
      name: 'Todas',
      path: '',
      categoryPath: 'Biblioteca Completa',
      cover: firstCover,
      trackCount: tracks.length,
      tracks
    }
  }, [allAlbums])

  // Biblioteca final incluyendo el álbum "Todas" al principio
  const library = useMemo(() => {
    if (!allTracksAlbum) return rawLibrary
    return [allTracksAlbum, ...rawLibrary]
  }, [allTracksAlbum, rawLibrary])

  const lastTimeSyncRef = useRef(0)
  const lastSentPlaylistRef = useRef(null)

  // Cargar biblioteca de música (se ejecuta estrictamente una sola vez)
  const loadLibrary = useCallback(async (directory = window.localStorage.getItem('musicPlayerDirectory') || undefined) => {
    setIsLoading(true)
    try {
      const tree = await window.electronAPI.scanMusic(directory)
      setRawLibrary(tree || [])
    } catch (err) {
      console.error('Error cargando biblioteca:', err)
    }
    setIsLoading(false)
  }, []) // Dependencias vacías: NUNCA se vuelve a ejecutar al seleccionar un álbum

  // Seleccionar automáticamente el álbum "Todas" (o el primero disponible) al cargar la biblioteca
  useEffect(() => {
    if (isMiniPanel) return
    if (library.length > 0) {
      setSelectedAlbum(prev => {
        if (!prev) return allTracksAlbum || findFirstAlbum(library)
        if (prev.id === '__all_tracks__' && allTracksAlbum) return allTracksAlbum
        return prev
      })
    }
  }, [isMiniPanel, library, allTracksAlbum])

  // Precargar cola de reproducción inicial cuando aún no suena ninguna pista para sincronizar el MiniPanel desde el arranque
  useEffect(() => {
    if (isMiniPanel) return
    if (!currentTrack && selectedAlbum?.tracks?.length > 0) {
      setPlaylist(selectedAlbum.tracks)
      setCurrentAlbum(selectedAlbum)
    }
  }, [isMiniPanel, currentTrack, selectedAlbum])

  const updateMusicDirectory = useCallback(async (directory) => {
    window.localStorage.setItem('musicPlayerDirectory', directory)
    setMusicDirectory(directory)
    setSelectedAlbum(null)
    await loadLibrary(directory)
  }, [loadLibrary])

  const historyRef = useRef([])
  const futureRef = useRef([])
  // Cola barajada (Fisher-Yates) y conjunto de pistas ya reproducidas en el ciclo actual
  const shuffleQueueRef = useRef([])
  const playedInCycleRef = useRef(new Set())
  const shufflePlaylistRef = useRef(null)

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

  // Barajado uniforme Fisher-Yates de índices candidatos
  const buildShuffledIndices = useCallback((list, excludeIds = new Set(), avoidRecentIds = new Set()) => {
    const indices = []
    for (let i = 0; i < list.length; i++) {
      const id = list[i]?.id ?? i
      if (!excludeIds.has(id)) {
        indices.push(i)
      }
    }
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = indices[i]
      indices[i] = indices[j]
      indices[j] = tmp
    }
    // Como extraemos con .pop(), el próximo en sonar es el último elemento del array.
    // Evitar que las canciones recién escuchadas al final del ciclo anterior salgan primeras en el nuevo ciclo.
    if (avoidRecentIds.size > 0 && indices.length > avoidRecentIds.size) {
      const fresh = []
      const recent = []
      for (const idx of indices) {
        const id = list[idx]?.id ?? idx
        if (avoidRecentIds.has(id)) {
          recent.push(idx)
        } else {
          fresh.push(idx)
        }
      }
      // recent al principio del array (saldrán al final del ciclo), fresh al final (saldrán primero con .pop())
      return [...recent, ...fresh]
    }
    return indices
  }, [])

  // Carga un archivo de audio en el elemento Audio y actualiza estados de reproducción
  const loadAndPlayTrack = useCallback((track, album = null, index = -1) => {
    const audio = audioRef.current

    // Inicializar o reanudar Web Audio Analyser
    initAudioAnalyser()
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {})
    }

    if (track?.id != null) {
      playedInCycleRef.current.add(track.id)
    }

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

    const playPromise = audio.play()
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          setIsPlaying(!audio.paused)
          if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume().catch(() => {})
          }
        })
        .catch((err) => {
          if (err?.name !== 'AbortError') {
            console.error('Error reproduciendo audio:', err)
          }
        })
    }
  }, [initAudioAnalyser])

  // Reproducir pista específica (selección manual)
  const playTrack = useCallback((track, album = null, newPlaylist = null, index = 0) => {
    if (newPlaylist) {
      setPlaylist(newPlaylist)
      if (shufflePlaylistRef.current !== newPlaylist) {
        shufflePlaylistRef.current = newPlaylist
        playedInCycleRef.current = new Set(track?.id != null ? [track.id] : [])
        shuffleQueueRef.current = buildShuffledIndices(newPlaylist, playedInCycleRef.current)
      }
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
  }, [currentTrack, currentAlbum, playlistIndex, loadAndPlayTrack, buildShuffledIndices])

  // Alternar reproducir/pausar (inicia la cola activa si aún no hay pista seleccionada)
  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!currentTrack) {
      const candidateList = playlist.length > 0 ? playlist : (selectedAlbum?.tracks || [])
      if (candidateList.length > 0) {
        const startIdx = shuffle ? Math.floor(Math.random() * candidateList.length) : 0
        playTrack(candidateList[startIdx], currentAlbum || selectedAlbum, candidateList, startIdx)
      }
      return
    }
    initAudioAnalyser()
    if (audio.paused) {
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {})
      }
      const p = audio.play()
      if (p !== undefined) {
        p.then(() => setIsPlaying(!audio.paused)).catch((err) => {
          if (err?.name !== 'AbortError') console.error(err)
        })
      }
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }, [currentTrack, playlist, selectedAlbum, currentAlbum, shuffle, playTrack, initAudioAnalyser])

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

  // Alternar modo aleatorio (reinicia la bolsa barajada con las canciones aún no reproducidas)
  const toggleShuffle = useCallback(() => {
    setShuffle(prev => {
      const next = !prev
      if (next && playlist.length > 0) {
        const currentId = currentTrack?.id ?? playlist[playlistIndex]?.id
        playedInCycleRef.current = new Set(currentId != null ? [currentId] : [])
        shufflePlaylistRef.current = playlist
        shuffleQueueRef.current = buildShuffledIndices(playlist, playedInCycleRef.current)
      }
      return next
    })
  }, [playlist, currentTrack, playlistIndex, buildShuffledIndices])

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
      if (playlist.length === 1) {
        nextIndex = 0
      } else {
        const currentId = currentTrack?.id ?? playlist[playlistIndex]?.id
        if (currentId != null) {
          playedInCycleRef.current.add(currentId)
        }

        // Si cambió la referencia de playlist, reconstruir la cola barajada
        if (shufflePlaylistRef.current !== playlist) {
          shufflePlaylistRef.current = playlist
          shuffleQueueRef.current = buildShuffledIndices(playlist, playedInCycleRef.current)
        }

        // Extraer el siguiente índice válido que no haya sido reproducido aún en este ciclo
        while (shuffleQueueRef.current.length > 0) {
          const candidate = shuffleQueueRef.current.pop()
          const candidateTrack = playlist[candidate]
          const candidateId = candidateTrack?.id ?? candidate
          if (
            candidateTrack &&
            candidate !== playlistIndex &&
            !playedInCycleRef.current.has(candidateId)
          ) {
            nextIndex = candidate
            break
          }
        }

        // Si ya sonaron todas las canciones de la lista en este ciclo, iniciar un nuevo ciclo completo sin repetir las recientes
        if (nextIndex === -1) {
          playedInCycleRef.current = new Set(currentId != null ? [currentId] : [])
          const recentLimit = Math.min(Math.floor(playlist.length / 2), 5)
          const avoidRecentIds = new Set()
          for (let i = historyRef.current.length - 1; i >= 0 && avoidRecentIds.size < recentLimit; i--) {
            const hId = historyRef.current[i]?.track?.id
            if (hId != null) avoidRecentIds.add(hId)
          }
          shuffleQueueRef.current = buildShuffledIndices(playlist, playedInCycleRef.current, avoidRecentIds)
          nextIndex = shuffleQueueRef.current.length > 0 ? shuffleQueueRef.current.pop() : 0
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
  }, [playlist, playlistIndex, shuffle, loop, currentTrack, currentAlbum, loadAndPlayTrack, buildShuffledIndices])

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
  const playAlbum = useCallback((album, startIndex) => {
    if (!album || !album.tracks || album.tracks.length === 0) return
    const tracks = [...album.tracks]
    const initialIdx =
      typeof startIndex === 'number'
        ? startIndex
        : shuffle
          ? Math.floor(Math.random() * tracks.length)
          : 0
    setPlaylist(tracks)
    setPlaylistIndex(initialIdx)
    setCurrentAlbum(album)
    playTrack(tracks[initialIdx], album, tracks, initialIdx)
  }, [playTrack, shuffle])

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
      // Throttling equilibrado (~250ms) para fluidez visual en MiniPanel sin saturar IPC
      const now = performance.now()
      if (now - lastTimeSyncRef.current >= 250) {
        lastTimeSyncRef.current = now
        window.electronAPI.sendPlayerTime?.(t)
      }
    }
    const onDurationChange = () => { if (audio.duration) setDuration(audio.duration) }
    const onLoadedMetadata = () => { if (audio.duration) setDuration(audio.duration) }
    const onEnded = () => handleTrackEnd()
    const onPlay = () => {
      setIsPlaying(true)
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {})
      }
    }
    const onPlaying = () => {
      setIsPlaying(true)
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {})
      }
    }
    const onPause = () => {
      if (audio.paused) {
        setIsPlaying(false)
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('pause', onPause)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('pause', onPause)
    }
  }, [handleTrackEnd, volume])

  // Sincronizar estado con otras ventanas (Mini Panel) desde el inicio y ante cambios de controles o pista
  // Optimización de payload: la playlist completa solo se transfiere cuando realmente cambia la referencia
  useEffect(() => {
    if (!isMiniPanel && !isLoading) {
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
  }, [isMiniPanel, isLoading, currentTrack, currentAlbum, playlist, playlistIndex, isPlaying, duration, shuffle, loop, volume])

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
    audioContextRef,
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
