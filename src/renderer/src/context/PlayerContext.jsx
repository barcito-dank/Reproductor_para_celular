import { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { getTrackUniqueKey, TODOS_ALBUM_COVER } from '../utils/trackUtils'

const PlayerContext = createContext(null)
const PlayerTimeContext = createContext({ currentTime: 0 })

const SESSION_STORAGE_KEY = 'musicPlayerSessionState'

function loadSavedSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function resolveAudioSrc(track) {
  if (!track) return ''
  if (track.fileUrl) return track.fileUrl
  const normalized = (track.path || '').replace(/\\/g, '/')
  const fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
  return encodeURI(fileUrl).replace(/#/g, '%23')
}

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
  const savedSessionRef = useRef(!isMiniPanel ? loadSavedSession() : null)
  const sessionRestoredRef = useRef(false)
  const pendingRestoreSeekRef = useRef(null)
  const lastSessionSaveAtRef = useRef(0)

  const [rawLibrary, setRawLibrary] = useState([]) // Árbol jerárquico original de carpetas y álbumes
  const [currentTrack, setCurrentTrack] = useState(null)
  const [currentAlbum, setCurrentAlbum] = useState(null)
  const [playlist, setPlaylist] = useState([]) // Cola de reproducción
  const [playlistIndex, setPlaylistIndex] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => {
    const savedVol = savedSessionRef.current?.volume
    return typeof savedVol === 'number' && !isNaN(savedVol)
      ? Math.max(0, Math.min(1, savedVol))
      : 0.8
  })
  const [shuffle, setShuffle] = useState(() => Boolean(savedSessionRef.current?.shuffle))
  const [loop, setLoop] = useState(() => {
    const savedLoop = savedSessionRef.current?.loop
    return savedLoop === 'all' || savedLoop === 'one' ? savedLoop : 'none'
  }) // 'none' | 'all' | 'one'
  const [isLoading, setIsLoading] = useState(true)
  const [selectedAlbum, setSelectedAlbum] = useState(null)
  const [musicDirectory, setMusicDirectory] = useState(() => (
    window.localStorage.getItem('musicPlayerDirectory') || ''
  ))

  // allAlbums memoizado estrictamente basado en rawLibrary (se calcula una sola vez tras escanear)
  const allAlbums = useMemo(() => getAllAlbums(rawLibrary), [rawLibrary])

  // Mapa canónico de pertenencia de canciones a álbumes (identifica copias iguales y en cuántos/cuáles álbumes están)
  const songAlbumsMap = useMemo(() => {
    const map = new Map()
    if (!allAlbums || allAlbums.length === 0) return map

    for (const album of allAlbums) {
      if (!album.tracks) continue
      for (const track of album.tracks) {
        const uniqueKey = track.uniqueKey || getTrackUniqueKey(track)
        let entry = map.get(uniqueKey)
        if (!entry) {
          entry = {
            uniqueKey,
            albumIdsSet: new Set(),
            albumNamesSet: new Set(),
            copies: []
          }
          map.set(uniqueKey, entry)
        }
        entry.albumIdsSet.add(album.id)
        entry.albumNamesSet.add(album.name)
        entry.copies.push({
          albumId: album.id,
          albumName: album.name,
          albumPath: album.path,
          track
        })
      }
    }

    for (const entry of map.values()) {
      entry.albumIds = Array.from(entry.albumIdsSet)
      entry.albumNames = Array.from(entry.albumNamesSet)
      entry.albumCount = entry.albumIds.length
    }

    return map
  }, [allAlbums])

  // Álbum virtual "Todos" con canciones únicas de todos los álbumes y carátula genérica propia
  const allTracksAlbum = useMemo(() => {
    if (!allAlbums || allAlbums.length === 0) return null
    const tracks = []
    const seenByKey = new Map()

    for (const album of allAlbums) {
      if (!album.tracks) continue
      for (const track of album.tracks) {
        const uniqueKey = track.uniqueKey || getTrackUniqueKey(track)
        const cover = track.cover || album.cover || null
        const membership = songAlbumsMap.get(uniqueKey)

        if (!seenByKey.has(uniqueKey)) {
          seenByKey.set(uniqueKey, tracks.length)
          tracks.push({
            ...track,
            uniqueKey,
            cover,
            albumName: album.name,
            albumIds: membership ? membership.albumIds : [album.id],
            albumNames: membership ? membership.albumNames : [album.name],
            albumCount: membership ? membership.albumCount : 1
          })
        } else {
          // Si la primera copia encontrada no tenía carátula y otra copia en otro álbum sí tiene, conservar la carátula
          const existingIdx = seenByKey.get(uniqueKey)
          if (existingIdx !== undefined && !tracks[existingIdx].cover && cover) {
            tracks[existingIdx] = {
              ...tracks[existingIdx],
              cover
            }
          }
        }
      }
    }

    if (tracks.length === 0) return null

    return {
      id: '__all_tracks__',
      type: 'album',
      isAllTracks: true,
      name: 'Todos',
      path: '',
      categoryPath: 'Biblioteca Completa',
      cover: TODOS_ALBUM_COVER,
      trackCount: tracks.length,
      tracks
    }
  }, [allAlbums, songAlbumsMap])

  // Biblioteca final incluyendo el álbum "Todos" al principio
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

  // Restaurar sesión guardada (álbum, pista y posición) o seleccionar "Todos" al cargar la biblioteca
  useEffect(() => {
    if (isMiniPanel || library.length === 0) return

    if (!sessionRestoredRef.current) {
      sessionRestoredRef.current = true
      const saved = savedSessionRef.current
      const candidateAlbums = [allTracksAlbum, ...allAlbums].filter(Boolean)
      const findAlbumById = (id) => (id ? candidateAlbums.find((a) => a.id === id) : null)

      const restoredSelectedAlbum =
        findAlbumById(saved?.selectedAlbumId) || allTracksAlbum || findFirstAlbum(library)
      setSelectedAlbum(restoredSelectedAlbum)

      const restoredCurrentAlbum =
        findAlbumById(saved?.currentAlbumId) || restoredSelectedAlbum

      if (saved?.currentTrackId && restoredCurrentAlbum?.tracks?.length > 0) {
        let resolvedAlbum = restoredCurrentAlbum
        let foundIndex = resolvedAlbum.tracks.findIndex((t) => t.id === saved.currentTrackId)

        if (foundIndex === -1 && allTracksAlbum?.tracks?.length > 0) {
          const idxInAll = allTracksAlbum.tracks.findIndex((t) => t.id === saved.currentTrackId)
          if (idxInAll !== -1) {
            resolvedAlbum = allTracksAlbum
            foundIndex = idxInAll
          }
        }

        if (foundIndex !== -1) {
          const foundTrack = resolvedAlbum.tracks[foundIndex]
          const restoredTime =
            typeof saved.currentTime === 'number' &&
            !isNaN(saved.currentTime) &&
            saved.currentTime > 0 &&
            (!foundTrack.duration || saved.currentTime < foundTrack.duration - 1)
              ? saved.currentTime
              : 0

          setCurrentAlbum(resolvedAlbum)
          setPlaylist(resolvedAlbum.tracks)
          setPlaylistIndex(foundIndex)
          setCurrentTrack(foundTrack)
          if (foundTrack.duration) {
            setDuration(foundTrack.duration)
          }
          setCurrentTime(restoredTime)

          const audio = audioRef.current
          pendingRestoreSeekRef.current = restoredTime
          audio.src = resolveAudioSrc(foundTrack)
          if (restoredTime > 0) {
            try {
              audio.currentTime = restoredTime
            } catch (_) {}
          }
          window.electronAPI.sendPlayerTime?.(restoredTime)
          return
        }
      }

      if (restoredSelectedAlbum?.tracks?.length > 0) {
        setPlaylist(restoredSelectedAlbum.tracks)
        setCurrentAlbum(restoredSelectedAlbum)
      }
      return
    }

    setSelectedAlbum((prev) => {
      if (!prev) return allTracksAlbum || findFirstAlbum(library)
      if (prev.id === '__all_tracks__' && allTracksAlbum) return allTracksAlbum
      return allAlbums.find((a) => a.id === prev.id) || allTracksAlbum || findFirstAlbum(library)
    })

    setCurrentAlbum((prev) => {
      if (!prev) return prev
      const updated =
        prev.id === '__all_tracks__'
          ? allTracksAlbum
          : allAlbums.find((a) => a.id === prev.id)
      if (updated && updated.tracks) {
        setPlaylist(updated.tracks)
        if (currentTrack) {
          const nextIdx = updated.tracks.findIndex((t) => t.id === currentTrack.id)
          if (nextIdx !== -1) {
            setPlaylistIndex(nextIdx)
            setCurrentTrack(updated.tracks[nextIdx])
          }
        }
        return updated
      }
      return prev
    })
  }, [isMiniPanel, library, allTracksAlbum, allAlbums])

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
    sessionRestoredRef.current = false
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
    pendingRestoreSeekRef.current = null

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

    audio.src = resolveAudioSrc(track)

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

  const persistSession = useCallback((overrideTime) => {
    if (isMiniPanel || !sessionRestoredRef.current) return
    try {
      const timeToSave =
        typeof overrideTime === 'number' && !isNaN(overrideTime)
          ? overrideTime
          : audioRef.current
            ? audioRef.current.currentTime
            : 0
      const payload = {
        volume,
        shuffle,
        loop,
        selectedAlbumId: selectedAlbum?.id || null,
        currentAlbumId: currentAlbum?.id || null,
        currentTrackId: currentTrack?.id || null,
        currentTime: timeToSave
      }
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
    } catch (_) {}
  }, [isMiniPanel, volume, shuffle, loop, selectedAlbum, currentAlbum, currentTrack])

  // Navegar a posición de tiempo (scrubbing)
  const seekTo = useCallback((time) => {
    if (audioRef.current && !isNaN(time)) {
      pendingRestoreSeekRef.current = null
      audioRef.current.currentTime = time
      setCurrentTime(time)
      lastTimeSyncRef.current = performance.now()
      window.electronAPI.sendPlayerTime?.(time)
      persistSession(time)
    }
  }, [persistSession])

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
      // Guardar progreso de sesión de forma espaciada (~2s) para no sobrecargar localStorage
      if (now - lastSessionSaveAtRef.current >= 2000) {
        lastSessionSaveAtRef.current = now
        persistSession(t)
      }
    }
    const onDurationChange = () => { if (audio.duration) setDuration(audio.duration) }
    const onLoadedMetadata = () => {
      if (audio.duration) setDuration(audio.duration)
      if (pendingRestoreSeekRef.current != null) {
        const target = pendingRestoreSeekRef.current
        pendingRestoreSeekRef.current = null
        if (target > 0 && (!audio.duration || target < audio.duration)) {
          try {
            audio.currentTime = target
            setCurrentTime(target)
          } catch (_) {}
        }
      }
    }
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
        persistSession(audio.currentTime)
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
  }, [handleTrackEnd, volume, persistSession])

  // Persistir sesión ante cambios de pista, álbum, volumen, bucle o aleatorio y al cerrar ventana
  useEffect(() => {
    if (isMiniPanel || isLoading) return
    persistSession()

    const handleBeforeUnload = () => persistSession()
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isMiniPanel, isLoading, persistSession])

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

  // Obtener información completa de en cuántos y cuáles álbumes está una canción
  const getTrackAlbumInfo = useCallback((track) => {
    if (!track) {
      return {
        uniqueKey: '',
        albumCount: 0,
        albumIdsSet: new Set(),
        albumIds: [],
        albumNames: [],
        copies: []
      }
    }
    const uniqueKey = track.uniqueKey || getTrackUniqueKey(track)
    const entry = songAlbumsMap.get(uniqueKey)
    if (entry) return entry

    const fallbackIds = Array.isArray(track.albumIds) ? track.albumIds : []
    const fallbackNames = Array.isArray(track.albumNames) ? track.albumNames : []
    return {
      uniqueKey,
      albumCount: fallbackIds.length || 1,
      albumIdsSet: new Set(fallbackIds),
      albumIds: fallbackIds,
      albumNames: fallbackNames,
      copies: []
    }
  }, [songAlbumsMap])

  // Copiar/agregar una canción a uno o varios álbumes y actualizar biblioteca en vivo
  const addTrackToAlbums = useCallback(async (track, targetAlbums) => {
    if (!track?.path || !Array.isArray(targetAlbums) || targetAlbums.length === 0) {
      return { success: false }
    }
    try {
      const result = await window.electronAPI.addTrackToAlbums({
        sourceTrackPath: track.path,
        targetAlbums: targetAlbums.map((a) => ({
          id: a.id,
          name: a.name,
          path: a.path
        })),
        selectedDirectory: musicDirectory || undefined
      })
      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
      }
      return result || { success: false }
    } catch (err) {
      console.error('Error agregando canción a álbumes:', err)
      return { success: false, error: err.message }
    }
  }, [musicDirectory])

  // Eliminar archivo de canción del disco (liberando antes el reproductor si estaba cargada)
  const deleteTrackFromDisk = useCallback(async (track) => {
    if (!track?.path) return { success: false }
    try {
      const audio = audioRef.current
      if (currentTrack && (currentTrack.id === track.id || currentTrack.path === track.path)) {
        const remaining = playlist.filter((t) => t.id !== track.id && t.path !== track.path)
        audio.pause()
        setIsPlaying(false)
        audio.removeAttribute('src')
        audio.load()
        if (remaining.length > 0) {
          const nextIdx = Math.min(Math.max(0, playlistIndex), remaining.length - 1)
          const replacement = remaining[nextIdx]
          setCurrentTrack(replacement)
          setPlaylist(remaining)
          setPlaylistIndex(nextIdx)
          audio.src = resolveAudioSrc(replacement)
        } else {
          setCurrentTrack(null)
          setPlaylist([])
          setPlaylistIndex(-1)
          setCurrentTime(0)
          setDuration(0)
        }
      }

      const result = await window.electronAPI.deleteTrackFile({
        filePath: track.path,
        selectedDirectory: musicDirectory || undefined
      })

      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
      }
      return result || { success: false }
    } catch (err) {
      console.error('Error eliminando archivo de canción:', err)
      return { success: false, error: err.message }
    }
  }, [currentTrack, playlist, playlistIndex, musicDirectory])

  // Crear un nuevo álbum (carpeta) en la biblioteca y seleccionarlo automáticamente
  const createAlbum = useCallback(async (albumName, parentDir = null) => {
    if (!albumName || !window.electronAPI?.createAlbum) return { success: false }
    try {
      const result = await window.electronAPI.createAlbum({
        albumName,
        parentDir,
        selectedDirectory: musicDirectory || undefined
      })
      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
        const flat = getAllAlbums(result.library)
        const created = flat.find((a) => a.id === result.albumId || a.path === result.albumPath)
        if (created) {
          setSelectedAlbum(created)
        }
      }
      return result || { success: false }
    } catch (err) {
      console.error('Error creando álbum:', err)
      return { success: false, error: err.message }
    }
  }, [musicDirectory])

  // Mover un álbum o carpeta dentro o fuera de otro álbum/carpeta mediante Drag & Drop
  const moveAlbumFolder = useCallback(async (sourcePath, targetParentDir = '__ROOT__') => {
    if (!sourcePath || !window.electronAPI?.moveAlbumFolder) return { success: false }
    const audio = audioRef.current
    const normSource = sourcePath.replace(/\//g, '\\').toLowerCase()
    const currentTrackPathNorm = currentTrack?.path
      ? currentTrack.path.replace(/\//g, '\\').toLowerCase()
      : ''

    const trackInsideMovedFolder =
      currentTrackPathNorm &&
      (currentTrackPathNorm === normSource || currentTrackPathNorm.startsWith(normSource + '\\'))

    let savedResumeTime = 0
    let wasPlayingBeforeMove = false
    let relativeSubPath = ''

    if (trackInsideMovedFolder && audio) {
      savedResumeTime = audio.currentTime || 0
      wasPlayingBeforeMove = !audio.paused
      relativeSubPath = currentTrack.path.slice(sourcePath.length)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }

    try {
      const result = await window.electronAPI.moveAlbumFolder({
        sourcePath,
        targetParentDir,
        selectedDirectory: musicDirectory || undefined
      })

      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
        const flat = getAllAlbums(result.library)

        if (selectedAlbum && selectedAlbum.path) {
          const selNorm = selectedAlbum.path.replace(/\//g, '\\').toLowerCase()
          if (selNorm === normSource || selNorm.startsWith(normSource + '\\')) {
            const sub = selectedAlbum.path.slice(sourcePath.length)
            const nextAlbumPath = result.newPath + sub
            const movedAlbum = flat.find((a) => a.path === nextAlbumPath || a.id === nextAlbumPath)
            if (movedAlbum) setSelectedAlbum(movedAlbum)
          }
        }

        if (trackInsideMovedFolder && result.newPath && audio) {
          const nextTrackPath = result.newPath + relativeSubPath
          let foundTrack = null
          let foundAlbum = null
          for (const alb of flat) {
            const match = alb.tracks?.find((t) => t.path === nextTrackPath)
            if (match) {
              foundTrack = match
              foundAlbum = alb
              break
            }
          }
          if (foundTrack) {
            setCurrentTrack(foundTrack)
            if (foundAlbum) {
              setCurrentAlbum(foundAlbum)
              setPlaylist(foundAlbum.tracks)
            }
            pendingRestoreSeekRef.current = savedResumeTime
            audio.src = resolveAudioSrc(foundTrack)
            if (wasPlayingBeforeMove) {
              audio.play().then(() => setIsPlaying(true)).catch(() => {})
            }
          }
        }
      } else if (trackInsideMovedFolder && currentTrack && audio) {
        // Si falló o se canceló el movimiento, restaurar el src original
        pendingRestoreSeekRef.current = savedResumeTime
        audio.src = resolveAudioSrc(currentTrack)
        if (wasPlayingBeforeMove) {
          audio.play().then(() => setIsPlaying(true)).catch(() => {})
        }
      }

      return result || { success: false }
    } catch (err) {
      console.error('Error moviendo álbum:', err)
      return { success: false, error: err.message }
    }
  }, [musicDirectory, currentTrack, selectedAlbum])

  // Renombrar una carpeta de álbum
  const renameAlbumFolder = useCallback(async (albumPath, newName) => {
    if (!albumPath || !newName || !window.electronAPI?.renameAlbumFolder) return { success: false }
    const audio = audioRef.current
    const normSource = albumPath.replace(/\//g, '\\').toLowerCase()
    const currentTrackPathNorm = currentTrack?.path
      ? currentTrack.path.replace(/\//g, '\\').toLowerCase()
      : ''

    const trackInsideFolder =
      currentTrackPathNorm &&
      (currentTrackPathNorm === normSource || currentTrackPathNorm.startsWith(normSource + '\\'))

    let savedResumeTime = 0
    let wasPlayingBefore = false
    let relativeSubPath = ''

    if (trackInsideFolder && audio) {
      savedResumeTime = audio.currentTime || 0
      wasPlayingBefore = !audio.paused
      relativeSubPath = currentTrack.path.slice(albumPath.length)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }

    try {
      const result = await window.electronAPI.renameAlbumFolder({
        albumPath,
        newName,
        selectedDirectory: musicDirectory || undefined
      })

      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
        const flat = getAllAlbums(result.library)

        if (selectedAlbum && selectedAlbum.path) {
          const selNorm = selectedAlbum.path.replace(/\//g, '\\').toLowerCase()
          if (selNorm === normSource || selNorm.startsWith(normSource + '\\')) {
            const sub = selectedAlbum.path.slice(albumPath.length)
            const nextAlbumPath = (result.newPath || albumPath) + sub
            const updatedAlbum = flat.find((a) => a.path === nextAlbumPath || a.id === nextAlbumPath)
            if (updatedAlbum) setSelectedAlbum(updatedAlbum)
          }
        }

        if (trackInsideFolder && result.newPath && audio) {
          const nextTrackPath = result.newPath + relativeSubPath
          let foundTrack = null
          let foundAlbum = null
          for (const alb of flat) {
            const match = alb.tracks?.find((t) => t.path === nextTrackPath)
            if (match) {
              foundTrack = match
              foundAlbum = alb
              break
            }
          }
          if (foundTrack) {
            setCurrentTrack(foundTrack)
            if (foundAlbum) {
              setCurrentAlbum(foundAlbum)
              setPlaylist(foundAlbum.tracks)
            }
            pendingRestoreSeekRef.current = savedResumeTime
            audio.src = resolveAudioSrc(foundTrack)
            if (wasPlayingBefore) {
              audio.play().then(() => setIsPlaying(true)).catch(() => {})
            }
          }
        }
      } else if (trackInsideFolder && currentTrack && audio) {
        pendingRestoreSeekRef.current = savedResumeTime
        audio.src = resolveAudioSrc(currentTrack)
        if (wasPlayingBefore) {
          audio.play().then(() => setIsPlaying(true)).catch(() => {})
        }
      }

      return result || { success: false }
    } catch (err) {
      console.error('Error renombrando álbum:', err)
      return { success: false, error: err.message }
    }
  }, [musicDirectory, currentTrack, selectedAlbum])

  // Eliminar una carpeta de álbum
  const deleteAlbumFolder = useCallback(async (albumPath) => {
    if (!albumPath || !window.electronAPI?.deleteAlbumFolder) return { success: false }
    const audio = audioRef.current
    const normSource = albumPath.replace(/\//g, '\\').toLowerCase()
    const currentTrackPathNorm = currentTrack?.path
      ? currentTrack.path.replace(/\//g, '\\').toLowerCase()
      : ''

    const trackInsideFolder =
      currentTrackPathNorm &&
      (currentTrackPathNorm === normSource || currentTrackPathNorm.startsWith(normSource + '\\'))

    if (trackInsideFolder && audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      setCurrentTrack(null)
      setCurrentAlbum(null)
      setPlaylist([])
      setIsPlaying(false)
    }

    try {
      const result = await window.electronAPI.deleteAlbumFolder({
        albumPath,
        selectedDirectory: musicDirectory || undefined
      })

      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)

        if (selectedAlbum && selectedAlbum.path) {
          const selNorm = selectedAlbum.path.replace(/\//g, '\\').toLowerCase()
          if (selNorm === normSource || selNorm.startsWith(normSource + '\\')) {
            setSelectedAlbum(null)
          }
        }
      }

      return result || { success: false }
    } catch (err) {
      console.error('Error eliminando álbum:', err)
      return { success: false, error: err.message }
    }
  }, [musicDirectory, currentTrack, selectedAlbum])

  // Contexto principal memoizado: solo cambia cuando cambian datos reales de pista, biblioteca o controles
  // currentTime NO está en estas dependencias, por lo que AlbumView, Sidebar, etc. no se re-renderizan
  const playerValue = useMemo(() => ({
    library,
    allAlbums,
    songAlbumsMap,
    getTrackAlbumInfo,
    addTrackToAlbums,
    deleteTrackFromDisk,
    createAlbum,
    moveAlbumFolder,
    renameAlbumFolder,
    deleteAlbumFolder,
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
    songAlbumsMap,
    getTrackAlbumInfo,
    addTrackToAlbums,
    deleteTrackFromDisk,
    createAlbum,
    moveAlbumFolder,
    renameAlbumFolder,
    deleteAlbumFolder,
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
