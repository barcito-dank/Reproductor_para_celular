import { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { getTrackUniqueKey, TODOS_ALBUM_COVER } from '../utils/trackUtils'

const LibraryContext = createContext(null)
const PlaybackContext = createContext(null)
const PlayerContext = createContext(null)
const PlayerTimeContext = createContext({ currentTime: 0 })

export const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]

export const EQ_PRESETS = {
  'Plano': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [7, 6, 4, 2, 0, 0, 0, 0, 1, 1],
  'Rock': [5, 3, -1, -2, -1, 1, 3, 4, 4, 3],
  'Pop': [-1, -1, 0, 2, 4, 4, 2, 0, -1, -1],
  'Vocal': [-2, -1, -1, 1, 3, 4, 3, 2, 1, 0],
  'Club / Dance': [6, 4, 2, 0, -2, 2, 3, 4, 4, 3],
  'Agudos': [-2, -2, -1, 0, 0, 2, 4, 6, 7, 8]
}

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

// Calcula de forma pura toda la estructura derivada de la biblioteca en un solo paso
function buildDerivedLibraryData(rawNodes) {
  const allAlbums = getAllAlbums(rawNodes)
  const songAlbumsMap = new Map()

  if (allAlbums.length > 0) {
    for (const album of allAlbums) {
      if (!album.tracks) continue
      for (const track of album.tracks) {
        const uniqueKey = track.uniqueKey || getTrackUniqueKey(track)
        let entry = songAlbumsMap.get(uniqueKey)
        if (!entry) {
          entry = {
            uniqueKey,
            albumIdsSet: new Set(),
            albumNamesSet: new Set(),
            copies: []
          }
          songAlbumsMap.set(uniqueKey, entry)
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

    for (const entry of songAlbumsMap.values()) {
      entry.albumIds = Array.from(entry.albumIdsSet)
      entry.albumNames = Array.from(entry.albumNamesSet)
      entry.albumCount = entry.albumIds.length
    }
  }

  let allTracksAlbum = null
  if (allAlbums.length > 0) {
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
            albumObj: album,
            albumName: album.name,
            albumIds: membership ? membership.albumIds : [album.id],
            albumNames: membership ? membership.albumNames : [album.name],
            albumCount: membership ? membership.albumCount : 1
          })
        } else {
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

    if (tracks.length > 0) {
      allTracksAlbum = {
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
    }
  }

  const allTracks = allTracksAlbum?.tracks || []
  const sorted = [...(rawNodes || [])].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1
    }
    return (a.name || '').localeCompare(b.name || '')
  })
  const library = allTracksAlbum ? [allTracksAlbum, ...sorted] : sorted

  return {
    allAlbums,
    songAlbumsMap,
    allTracksAlbum,
    allTracks,
    library
  }
}

export function PlayerProvider({ children, isMiniPanel = false }) {
  // Instanciar HTMLAudioElement una sola vez y únicamente en la ventana principal
  const audioRef = useRef(null)
  if (!isMiniPanel && !audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio()
  }
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

  // Estructura derivada memoizada en un único bloque coherente
  const {
    allAlbums,
    songAlbumsMap,
    allTracksAlbum,
    allTracks,
    library
  } = useMemo(() => buildDerivedLibraryData(rawLibrary), [rawLibrary])

  const lastTimeSyncRef = useRef(0)
  const lastSentPlaylistRef = useRef(null)

  // Cargar biblioteca de música y restaurar sesión atómicamente en un único lote de renderizado
  const loadLibrary = useCallback(async (directory = window.localStorage.getItem('musicPlayerDirectory') || undefined) => {
    setIsLoading(true)
    try {
      const tree = await window.electronAPI.scanMusic(directory)
      const normalizedTree = tree || []

      if (!isMiniPanel && !sessionRestoredRef.current && normalizedTree.length > 0) {
        sessionRestoredRef.current = true
        const derived = buildDerivedLibraryData(normalizedTree)
        const saved = savedSessionRef.current
        const candidateAlbums = [derived.allTracksAlbum, ...derived.allAlbums].filter(Boolean)
        const findAlbumById = (id) => (id ? candidateAlbums.find((a) => a.id === id) : null)

        const restoredSelectedAlbum =
          findAlbumById(saved?.selectedAlbumId) || derived.allTracksAlbum || findFirstAlbum(derived.library)
        setSelectedAlbum(restoredSelectedAlbum)

        const restoredCurrentAlbum =
          findAlbumById(saved?.currentAlbumId) || restoredSelectedAlbum

        let restoredTrackApplied = false
        if (saved?.currentTrackId && restoredCurrentAlbum?.tracks?.length > 0) {
          let resolvedAlbum = restoredCurrentAlbum
          let foundIndex = resolvedAlbum.tracks.findIndex((t) => t.id === saved.currentTrackId)

          if (foundIndex === -1 && derived.allTracksAlbum?.tracks?.length > 0) {
            const idxInAll = derived.allTracksAlbum.tracks.findIndex((t) => t.id === saved.currentTrackId)
            if (idxInAll !== -1) {
              resolvedAlbum = derived.allTracksAlbum
              foundIndex = idxInAll
            }
          }

          if (foundIndex !== -1) {
            const rawTrack = resolvedAlbum.tracks[foundIndex]
            const foundTrack = {
              ...rawTrack,
              cover: rawTrack.cover || resolvedAlbum.cover || null
            }
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
            if (audio) {
              pendingRestoreSeekRef.current = restoredTime
              audio.src = resolveAudioSrc(foundTrack)
              if (restoredTime > 0) {
                try {
                  audio.currentTime = restoredTime
                } catch (_) {}
              }
            }
            window.electronAPI.sendPlayerTime?.(restoredTime)
            restoredTrackApplied = true
          }
        }

        if (!restoredTrackApplied && restoredSelectedAlbum?.tracks?.length > 0) {
          setPlaylist(restoredSelectedAlbum.tracks)
          setCurrentAlbum(restoredSelectedAlbum)
        }
      }

      setRawLibrary(normalizedTree)
    } catch (err) {
      console.error('Error cargando biblioteca:', err)
    }
    setIsLoading(false)
    if (!isMiniPanel) {
      requestAnimationFrame(() => {
        window.electronAPI?.notifyRendererReady?.()
      })
    }
  }, [isMiniPanel]) // NUNCA se vuelve a ejecutar al seleccionar un álbum

  // Sincronizar álbum seleccionado y cola activa ante actualizaciones posteriores de la biblioteca (Watcher, edición, etc.)
  useEffect(() => {
    if (isMiniPanel || library.length === 0) return

    if (!sessionRestoredRef.current) {
      sessionRestoredRef.current = true
      const restoredSelectedAlbum = allTracksAlbum || findFirstAlbum(library)
      setSelectedAlbum(restoredSelectedAlbum)
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

  // Web Audio API para análisis de espectro en tiempo real y ecualizador paramétrico de 10 bandas
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const eqFiltersRef = useRef([])
  const compressorRef = useRef(null)
  const crossfadeGainRef = useRef(null)

  // Configuración general de la aplicación (guardada en localStorage y sincronizada con Electron)
  const [appSettings, setAppSettings] = useState(() => {
    try {
      const saved = window.localStorage.getItem('musicPlayerAppSettings')
      if (saved) {
        const parsed = JSON.parse(saved)
        return {
          replayGain: Boolean(parsed.replayGain),
          crossfadeEnabled: Boolean(parsed.crossfadeEnabled),
          crossfadeDuration: typeof parsed.crossfadeDuration === 'number' ? parsed.crossfadeDuration : 3,
          discordRpc: Boolean(parsed.discordRpc),
          gameOverlay: false, // Siempre inicia desactivado al arrancar la app para no aparecer sin ser activado
          autoLyrics: parsed.autoLyrics !== undefined ? Boolean(parsed.autoLyrics) : true,
          lyricsMode: parsed.lyricsMode === 'permanent' ? 'permanent' : 'temporary', // 'temporary' (en memoria) | 'permanent' (guardar .lrc)
          alwaysOnTop: Boolean(parsed.alwaysOnTop)
        }
      }
    } catch (_) {}
    return {
      replayGain: false,
      crossfadeEnabled: false,
      crossfadeDuration: 3,
      discordRpc: false,
      gameOverlay: false,
      autoLyrics: true,
      lyricsMode: 'temporary',
      alwaysOnTop: false
    }
  })

  const appSettingsRef = useRef(appSettings)
  appSettingsRef.current = appSettings

  // Estado reactivo de letras para informar en tiempo real a LyricsDock y Player
  const [currentLyrics, setCurrentLyrics] = useState({
    trackPath: null,
    status: 'idle', // 'idle' | 'loading' | 'searching-online' | 'ready' | 'not-found'
    synced: false,
    lines: [],
    source: null, // 'lrc' | 'id3-sylt' | 'id3-uslt' | 'metadata' | 'online-temp'
    savedToDisk: false,
    rawLyrics: null,
    matchedTrack: null
  })

  const updateReplayGainNode = useCallback((enabled) => {
    if (!compressorRef.current || !audioContextRef.current) return
    const ctx = audioContextRef.current
    const comp = compressorRef.current
    const now = ctx.currentTime
    try {
      if (enabled) {
        comp.threshold.setValueAtTime(-20, now)
        comp.knee.setValueAtTime(30, now)
        comp.ratio.setValueAtTime(8, now)
        comp.attack.setValueAtTime(0.003, now)
        comp.release.setValueAtTime(0.25, now)
      } else {
        comp.threshold.setValueAtTime(0, now)
        comp.ratio.setValueAtTime(1, now)
      }
    } catch (_) {}
  }, [])

  const updateAppSettings = useCallback((patch) => {
    setAppSettings((prev) => {
      const partial = typeof patch === 'function' ? patch(prev) : patch
      if (!partial || typeof partial !== 'object') return prev
      const next = { ...prev, ...partial }
      appSettingsRef.current = next
      try {
        window.localStorage.setItem('musicPlayerAppSettings', JSON.stringify(next))
      } catch (_) {}

      if (!isMiniPanel) {
        if (Boolean(next.replayGain) !== Boolean(prev.replayGain)) {
          updateReplayGainNode(Boolean(next.replayGain))
        }
        if (Boolean(next.discordRpc) !== Boolean(prev.discordRpc) && window.electronAPI?.setDiscordRpc) {
          window.electronAPI.setDiscordRpc(Boolean(next.discordRpc))
        }
        if (Boolean(next.gameOverlay) !== Boolean(prev.gameOverlay) && window.electronAPI?.toggleGameOverlay) {
          window.electronAPI.toggleGameOverlay(Boolean(next.gameOverlay))
        }
        if (Boolean(next.alwaysOnTop) !== Boolean(prev.alwaysOnTop) && window.electronAPI?.setMainAlwaysOnTop) {
          window.electronAPI.setMainAlwaysOnTop(Boolean(next.alwaysOnTop))
        }
      }

      return next
    })
  }, [isMiniPanel, updateReplayGainNode])

  // Inicializar integraciones de Electron según settings guardados (solo en ventana principal)
  useEffect(() => {
    if (isMiniPanel) return
    if (appSettingsRef.current.discordRpc && window.electronAPI?.setDiscordRpc) {
      window.electronAPI.setDiscordRpc(true)
    }
    if (appSettingsRef.current.alwaysOnTop && window.electronAPI?.setMainAlwaysOnTop) {
      window.electronAPI.setMainAlwaysOnTop(true)
    }
    // Asegurar que el HUD Overlay permanezca cerrado salvo que el usuario lo active explícitamente
    if (window.electronAPI?.toggleGameOverlay) {
      window.electronAPI.toggleGameOverlay(false)
    }

    let unsubOverlay = null
    if (window.electronAPI?.onGameOverlayStatusChanged) {
      unsubOverlay = window.electronAPI.onGameOverlayStatusChanged((active) => {
        setAppSettings((prev) => {
          if (Boolean(prev.gameOverlay) === Boolean(active)) return prev
          const next = { ...prev, gameOverlay: Boolean(active) }
          appSettingsRef.current = next
          try {
            window.localStorage.setItem('musicPlayerAppSettings', JSON.stringify(next))
          } catch (_) {}
          return next
        })
      })
    }

    let unsubTop = null
    if (window.electronAPI?.onAlwaysOnTopStatusChanged) {
      unsubTop = window.electronAPI.onAlwaysOnTopStatusChanged((isTop) => {
        setAppSettings((prev) => {
          if (Boolean(prev.alwaysOnTop) === Boolean(isTop)) return prev
          const next = { ...prev, alwaysOnTop: Boolean(isTop) }
          appSettingsRef.current = next
          try {
            window.localStorage.setItem('musicPlayerAppSettings', JSON.stringify(next))
          } catch (_) {}
          return next
        })
      })
    }

    return () => {
      if (unsubOverlay) unsubOverlay()
      if (unsubTop) unsubTop()
    }
  }, [isMiniPanel])

  // Estado persistente del ecualizador
  const [eqState, setEqState] = useState(() => {
    try {
      const saved = window.localStorage.getItem('musicPlayerEqSettings')
      if (saved) return JSON.parse(saved)
    } catch (_) {}
    return {
      enabled: false,
      preset: 'Plano',
      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  })
  const eqStateRef = useRef(eqState)
  eqStateRef.current = eqState

  const updateFilterGains = useCallback((gains, enabled) => {
    if (!eqFiltersRef.current || eqFiltersRef.current.length === 0) return
    const ctxTime = audioContextRef.current?.currentTime || 0
    eqFiltersRef.current.forEach((filter, i) => {
      const targetGain = enabled ? (gains[i] ?? 0) : 0
      try {
        filter.gain.setTargetAtTime(targetGain, ctxTime, 0.02)
      } catch (_) {
        filter.gain.value = targetGain
      }
    })
  }, [])

  const initAudioAnalyser = useCallback(() => {
    if (isMiniPanel || !audioRef.current) return null
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

      // Cadena de 10 filtros paramétricos para el ecualizador
      const currentEq = eqStateRef.current
      const filters = EQ_FREQUENCIES.map((freq, i) => {
        const filter = ctx.createBiquadFilter()
        if (i === 0) {
          filter.type = 'lowshelf'
        } else if (i === EQ_FREQUENCIES.length - 1) {
          filter.type = 'highshelf'
        } else {
          filter.type = 'peaking'
          filter.Q.value = 1.4
        }
        filter.frequency.value = freq
        const initialGain = currentEq?.enabled ? (currentEq.gains[i] ?? 0) : 0
        filter.gain.value = initialGain
        return filter
      })

      // Conexión en cascada: source -> filters -> compressor (ReplayGain) -> crossfadeGain -> analyser -> destination
      let prevNode = source
      for (const filter of filters) {
        prevNode.connect(filter)
        prevNode = filter
      }

      const compressor = ctx.createDynamicsCompressor()
      const crossfadeGain = ctx.createGain()
      crossfadeGain.gain.value = 1.0

      if (appSettingsRef.current.replayGain) {
        compressor.threshold.setValueAtTime(-20, ctx.currentTime)
        compressor.knee.setValueAtTime(30, ctx.currentTime)
        compressor.ratio.setValueAtTime(8, ctx.currentTime)
        compressor.attack.setValueAtTime(0.003, ctx.currentTime)
        compressor.release.setValueAtTime(0.25, ctx.currentTime)
      } else {
        compressor.threshold.setValueAtTime(0, ctx.currentTime)
        compressor.ratio.setValueAtTime(1, ctx.currentTime)
      }

      prevNode.connect(compressor)
      compressor.connect(crossfadeGain)
      crossfadeGain.connect(analyser)
      analyser.connect(ctx.destination)

      audioContextRef.current = ctx
      analyserRef.current = analyser
      sourceNodeRef.current = source
      eqFiltersRef.current = filters
      compressorRef.current = compressor
      crossfadeGainRef.current = crossfadeGain

      if (ctx.state === 'suspended') {
        ctx.resume().catch(console.error)
      }

      return analyser
    } catch (e) {
      console.warn('Web Audio API analyser & EQ init:', e.message)
      return analyserRef.current
    }
  }, [isMiniPanel])

  const setEqBandGain = useCallback((bandIndex, gainDb) => {
    setEqState((prev) => {
      const nextGains = [...prev.gains]
      nextGains[bandIndex] = Math.max(-12, Math.min(12, Math.round(gainDb * 10) / 10))
      const nextState = { ...prev, preset: 'Personalizado', gains: nextGains }
      try {
        window.localStorage.setItem('musicPlayerEqSettings', JSON.stringify(nextState))
      } catch (_) {}
      updateFilterGains(nextGains, nextState.enabled)
      return nextState
    })
  }, [updateFilterGains])

  const applyEqPreset = useCallback((presetName) => {
    const presetGains = EQ_PRESETS[presetName] || EQ_PRESETS['Plano']
    setEqState((prev) => {
      const nextState = { ...prev, preset: presetName, gains: [...presetGains] }
      try {
        window.localStorage.setItem('musicPlayerEqSettings', JSON.stringify(nextState))
      } catch (_) {}
      updateFilterGains(presetGains, nextState.enabled)
      return nextState
    })
  }, [updateFilterGains])

  const toggleEqEnabled = useCallback(() => {
    setEqState((prev) => {
      const nextEnabled = !prev.enabled
      const nextState = { ...prev, enabled: nextEnabled }
      try {
        window.localStorage.setItem('musicPlayerEqSettings', JSON.stringify(nextState))
      } catch (_) {}
      updateFilterGains(nextState.gains, nextEnabled)
      return nextState
    })
  }, [updateFilterGains])

  const resetEq = useCallback(() => {
    const flatGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    setEqState({
      enabled: true,
      preset: 'Plano',
      gains: flatGains
    })
    try {
      window.localStorage.setItem('musicPlayerEqSettings', JSON.stringify({
        enabled: true,
        preset: 'Plano',
        gains: flatGains
      }))
    } catch (_) {}
    updateFilterGains(flatGains, true)
  }, [updateFilterGains])

  // Gestión reactiva de letras (locales y búsqueda online temporal o permanente)
  const activeLyricsReqRef = useRef(0)

  const loadLyricsForTrack = useCallback(async (track, { forceOnline = false, bypassCache = false } = {}) => {
    if (isMiniPanel || !track?.path) {
      setCurrentLyrics({
        trackPath: null,
        status: 'idle',
        synced: false,
        lines: [],
        source: null,
        savedToDisk: false,
        rawLyrics: null,
        matchedTrack: null
      })
      return
    }

    const reqId = ++activeLyricsReqRef.current
    const targetPath = track.path

    // 1. Buscar primero letra local (.lrc / ID3) salvo que se fuerce búsqueda en línea
    if (!forceOnline && window.electronAPI?.getTrackLyrics) {
      setCurrentLyrics({
        trackPath: targetPath,
        status: 'loading',
        synced: false,
        lines: [],
        source: null,
        savedToDisk: false,
        rawLyrics: null,
        matchedTrack: null
      })

      try {
        const localRes = await window.electronAPI.getTrackLyrics(targetPath)
        if (reqId !== activeLyricsReqRef.current) return

        if (localRes && Array.isArray(localRes.lines) && localRes.lines.length > 0) {
          setCurrentLyrics({
            trackPath: targetPath,
            status: 'ready',
            synced: Boolean(localRes.synced),
            lines: localRes.lines,
            source: localRes.source || 'lrc',
            savedToDisk: true,
            rawLyrics: null,
            matchedTrack: null
          })
          setCurrentTrack((prev) => {
            if (!prev || prev.path !== targetPath) return prev
            if (prev.hasLyrics && prev.syncedLyrics === Boolean(localRes.synced)) return prev
            return { ...prev, hasLyrics: true, syncedLyrics: Boolean(localRes.synced) }
          })
          return
        }
      } catch (_) {
        if (reqId !== activeLyricsReqRef.current) return
      }
    }

    // 2. Si no hay letra local, verificar si la búsqueda automática en línea está activa (o si fue solicitada manualmente)
    const shouldSearchOnline = forceOnline || Boolean(appSettingsRef.current.autoLyrics)
    if (!shouldSearchOnline || !window.electronAPI?.fetchTrackLyricsOnline) {
      setCurrentLyrics({
        trackPath: targetPath,
        status: 'not-found',
        synced: false,
        lines: [],
        source: null,
        savedToDisk: false,
        rawLyrics: null,
        matchedTrack: null
      })
      return
    }

    // Informar inmediatamente al panel de letras que se está buscando en la base de datos en línea
    setCurrentLyrics({
      trackPath: targetPath,
      status: 'searching-online',
      synced: false,
      lines: [],
      source: null,
      savedToDisk: false,
      rawLyrics: null,
      matchedTrack: null
    })

    try {
      const saveToDisk = appSettingsRef.current.lyricsMode === 'permanent'
      const onlineRes = await window.electronAPI.fetchTrackLyricsOnline({
        trackPath: targetPath,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        saveToDisk,
        bypassCache
      })

      if (reqId !== activeLyricsReqRef.current) return

      if (onlineRes?.lyricsFound && onlineRes?.parsed?.lines?.length > 0) {
        const isSynced = Boolean(onlineRes.parsed.synced)
        const isSaved = Boolean(onlineRes.savedToDisk)
        setCurrentLyrics({
          trackPath: targetPath,
          status: 'ready',
          synced: isSynced,
          lines: onlineRes.parsed.lines,
          source: isSaved ? 'lrc' : 'online-temp',
          savedToDisk: isSaved,
          rawLyrics: onlineRes.lyrics || null,
          matchedTrack: onlineRes.matchedTrack || null
        })
        setCurrentTrack((prev) => {
          if (!prev || prev.path !== targetPath) return prev
          return { ...prev, hasLyrics: true, syncedLyrics: isSynced }
        })
      } else {
        setCurrentLyrics({
          trackPath: targetPath,
          status: 'not-found',
          synced: false,
          lines: [],
          source: null,
          savedToDisk: false,
          rawLyrics: null,
          matchedTrack: null
        })
      }
    } catch (_) {
      if (reqId !== activeLyricsReqRef.current) return
      setCurrentLyrics({
        trackPath: targetPath,
        status: 'not-found',
        synced: false,
        lines: [],
        source: null,
        savedToDisk: false,
        rawLyrics: null,
        matchedTrack: null
      })
    }
  }, [isMiniPanel])

  // Disparar carga de letras cada vez que cambia la pista activa o se activa autoLyrics
  useEffect(() => {
    if (isMiniPanel) return
    if (!currentTrack?.path) {
      setCurrentLyrics({
        trackPath: null,
        status: 'idle',
        synced: false,
        lines: [],
        source: null,
        savedToDisk: false,
        rawLyrics: null,
        matchedTrack: null
      })
      return
    }
    loadLyricsForTrack(currentTrack)
  }, [isMiniPanel, currentTrack?.path, appSettings.autoLyrics, loadLyricsForTrack])

  // Guardar manualmente en archivo .lrc una letra que estaba en modo temporal
  const saveCurrentLyricsToDisk = useCallback(async () => {
    if (!currentTrack?.path || !currentLyrics?.rawLyrics || !window.electronAPI?.saveTrackLrc) {
      return { success: false }
    }
    const res = await window.electronAPI.saveTrackLrc({
      trackPath: currentTrack.path,
      lyricsText: currentLyrics.rawLyrics
    })
    if (res?.success) {
      const isSynced = Boolean(currentLyrics?.synced)
      setCurrentLyrics((prev) => ({
        ...prev,
        source: 'lrc',
        savedToDisk: true
      }))
      setCurrentTrack((prev) => (prev ? { ...prev, hasLyrics: true, syncedLyrics: isSynced } : prev))
      setRawLibrary((prevLib) => {
        if (!Array.isArray(prevLib)) return prevLib
        return prevLib.map((album) => ({
          ...album,
          tracks: (album.tracks || []).map((t) =>
            t.path === currentTrack.path ? { ...t, hasLyrics: true, syncedLyrics: isSynced } : t
          )
        }))
      })
      setPlaylist((prevList) => {
        if (!Array.isArray(prevList)) return prevList
        return prevList.map((t) =>
          t.path === currentTrack.path ? { ...t, hasLyrics: true, syncedLyrics: isSynced } : t
        )
      })
    }
    return res
  }, [currentTrack?.path, currentLyrics?.rawLyrics, currentLyrics?.synced])

  // Eliminar archivo .lrc local si la letra descargada previamente no corresponde a la versión de la canción
  const deleteCurrentLyricsFromDisk = useCallback(async () => {
    if (!currentTrack?.path || !window.electronAPI?.deleteTrackLrc) {
      return { success: false }
    }
    const res = await window.electronAPI.deleteTrackLrc({ trackPath: currentTrack.path })
    if (res?.success) {
      setCurrentLyrics({
        trackPath: currentTrack.path,
        status: 'not-found',
        synced: false,
        lines: [],
        source: null,
        savedToDisk: false,
        rawLyrics: null,
        matchedTrack: null
      })
      setCurrentTrack((prev) => (prev ? { ...prev, hasLyrics: false, syncedLyrics: false } : prev))
      setRawLibrary((prevLib) => {
        if (!Array.isArray(prevLib)) return prevLib
        return prevLib.map((album) => ({
          ...album,
          tracks: (album.tracks || []).map((t) =>
            t.path === currentTrack.path ? { ...t, hasLyrics: false, syncedLyrics: false } : t
          )
        }))
      })
      setPlaylist((prevList) => {
        if (!Array.isArray(prevList)) return prevList
        return prevList.map((t) =>
          t.path === currentTrack.path ? { ...t, hasLyrics: false, syncedLyrics: false } : t
        )
      })
    }
    return res
  }, [currentTrack?.path])

  // Reintentar búsqueda de letra en línea
  const retryOnlineLyrics = useCallback(() => {
    if (!currentTrack?.path) return
    loadLyricsForTrack(currentTrack, { forceOnline: true, bypassCache: true })
  }, [currentTrack, loadLyricsForTrack])

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
    if (isMiniPanel || !track) return
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

    // Fundido de entrada suave (Crossfade) al iniciar la nueva pista si está activado
    if (appSettingsRef.current.crossfadeEnabled && crossfadeGainRef.current && audioContextRef.current) {
      try {
        const ctx = audioContextRef.current
        const gain = crossfadeGainRef.current
        const now = ctx.currentTime
        const fadeInDuration = Math.min(2.5, Math.max(0.6, (appSettingsRef.current.crossfadeDuration || 3) * 0.55))
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(0.08, now)
        gain.gain.linearRampToValueAtTime(1.0, now + fadeInDuration)
      } catch (_) {}
    } else if (crossfadeGainRef.current && audioContextRef.current) {
      try {
        const now = audioContextRef.current.currentTime
        crossfadeGainRef.current.gain.cancelScheduledValues(now)
        crossfadeGainRef.current.gain.setValueAtTime(1.0, now)
      } catch (_) {}
    }

    const resolvedCover = track.cover || album?.cover || null
    const trackWithCover = resolvedCover && !track.cover ? { ...track, cover: resolvedCover } : track

    setCurrentTrack(trackWithCover)
    if (album) setCurrentAlbum(album)
    if (index >= 0) setPlaylistIndex(index)

    if (track.duration) {
      setDuration(track.duration)
    }
    setCurrentTime(0)
    lastTimeSyncRef.current = performance.now()
    window.electronAPI.sendPlayerTime?.(0)

    audio.src = resolveAudioSrc(trackWithCover)

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
  }, [isMiniPanel, initAudioAnalyser])

  // Reproducir pista específica (selección manual)
  const playTrack = useCallback((track, album = null, newPlaylist = null, index = 0) => {
    if (isMiniPanel) {
      if (typeof index === 'number' && index >= 0) {
        window.electronAPI?.sendPlayerCommand?.('select-' + index)
      }
      return
    }
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

    loadAndPlayTrack(track, album || currentAlbum, index)
  }, [isMiniPanel, currentTrack, currentAlbum, playlistIndex, loadAndPlayTrack, buildShuffledIndices])

  // Alternar reproducir/pausar (inicia la cola activa si aún no hay pista seleccionada)
  const togglePlay = useCallback(() => {
    if (isMiniPanel) {
      window.electronAPI?.sendPlayerCommand?.('toggle-play')
      return
    }
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
  }, [isMiniPanel, currentTrack, playlist, selectedAlbum, currentAlbum, shuffle, playTrack, initAudioAnalyser])

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
    if (isMiniPanel) {
      if (!isNaN(time)) {
        window.electronAPI?.sendPlayerCommand?.('seek-' + time)
      }
      return
    }
    if (audioRef.current && !isNaN(time)) {
      pendingRestoreSeekRef.current = null
      audioRef.current.currentTime = time
      setCurrentTime(time)
      lastTimeSyncRef.current = performance.now()
      window.electronAPI.sendPlayerTime?.(time)
      persistSession(time)
    }
  }, [isMiniPanel, persistSession])

  // Control de volumen
  const setVolumeLevel = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v))
    setVolume(clamped)
    if (isMiniPanel) {
      window.electronAPI?.sendPlayerCommand?.('volume-' + clamped)
      return
    }
    if (audioRef.current) {
      audioRef.current.volume = clamped
    }
  }, [isMiniPanel])

  // Ajuste relativo de volumen
  const adjustVolume = useCallback((delta) => {
    setVolume((prev) => {
      const next = Math.max(0, Math.min(1, Math.round(((prev ?? 0.8) + delta) * 100) / 100))
      if (isMiniPanel) {
        window.electronAPI?.sendPlayerCommand?.('volume-' + next)
      } else if (audioRef.current) {
        audioRef.current.volume = next
      }
      return next
    })
  }, [isMiniPanel])

  // Alternar modo aleatorio (reinicia la bolsa barajada con las canciones aún no reproducidas)
  const toggleShuffle = useCallback(() => {
    if (isMiniPanel) {
      window.electronAPI?.sendPlayerCommand?.('toggle-shuffle')
      return
    }
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
  }, [isMiniPanel, playlist, currentTrack, playlistIndex, buildShuffledIndices])

  // Alternar bucle (none -> all -> one -> none)
  const toggleLoop = useCallback(() => {
    if (isMiniPanel) {
      window.electronAPI?.sendPlayerCommand?.('toggle-loop')
      return
    }
    setLoop(prev => {
      if (prev === 'none') return 'all'
      if (prev === 'all') return 'one'
      return 'none'
    })
  }, [isMiniPanel])

  // Siguiente canción
  const nextTrack = useCallback(() => {
    if (isMiniPanel) {
      window.electronAPI?.sendPlayerCommand?.('next')
      return
    }
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
  }, [isMiniPanel, playlist, playlistIndex, shuffle, loop, currentTrack, currentAlbum, loadAndPlayTrack, buildShuffledIndices])

  // Canción anterior: regresa fielmente por todas las canciones escuchadas previamente
  const previousTrack = useCallback(() => {
    if (isMiniPanel) {
      window.electronAPI?.sendPlayerCommand?.('previous')
      return
    }
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
  }, [isMiniPanel, playlist, playlistIndex, shuffle, loop, currentTrack, currentAlbum, loadAndPlayTrack])

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

  // Configurar listeners de eventos del objeto Audio (exclusivo para la ventana principal)
  useEffect(() => {
    if (isMiniPanel) return
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
        // Sincronizar posición con Windows SMTC / auriculares
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && audio.duration) {
          try {
            navigator.mediaSession.setPositionState({
              duration: audio.duration,
              playbackRate: 1,
              position: Math.min(audio.duration, Math.max(0, t))
            })
          } catch (_) {}
        }
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

      const enrichedTrack = currentTrack
        ? {
            ...currentTrack,
            cover: currentTrack.cover || currentAlbum?.cover || null
          }
        : null

      window.electronAPI.sendPlayerState({
        currentTrack: enrichedTrack,
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

  // Sincronización nativa con Media Session API (SMTC de Windows 10/11 y controles Bluetooth de auriculares)
  useEffect(() => {
    if (isMiniPanel || !('mediaSession' in navigator)) return

    if (currentTrack) {
      // W3C MediaSession solo acepta esquemas http, https, data o blob para artwork
      const hasValidMediaScheme = currentTrack.cover && /^(https?|data|blob):/i.test(currentTrack.cover)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || 'Canción',
        artist: currentTrack.artist || 'Artista Desconocido',
        album: currentAlbum?.name || currentTrack.albumName || '',
        artwork: hasValidMediaScheme
          ? [
              { src: currentTrack.cover, sizes: '96x96' },
              { src: currentTrack.cover, sizes: '128x128' },
              { src: currentTrack.cover, sizes: '256x256' },
              { src: currentTrack.cover, sizes: '512x512' }
            ]
          : []
      })
    } else {
      navigator.mediaSession.metadata = null
    }
  }, [isMiniPanel, currentTrack, currentAlbum])

  useEffect(() => {
    if (isMiniPanel || !('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isMiniPanel, isPlaying])

  useEffect(() => {
    if (isMiniPanel || !('mediaSession' in navigator)) return

    const handlers = [
      ['play', () => togglePlay()],
      ['pause', () => togglePlay()],
      ['previoustrack', () => previousTrack()],
      ['nexttrack', () => nextTrack()],
      ['seekto', (details) => {
        if (details.seekTime != null) seekTo(details.seekTime)
      }],
      ['seekbackward', (details) => {
        const skip = details.seekOffset || 10
        seekTo(Math.max(0, (audioRef.current?.currentTime || 0) - skip))
      }],
      ['seekforward', (details) => {
        const skip = details.seekOffset || 10
        seekTo(Math.min(duration || 0, (audioRef.current?.currentTime || 0) + skip))
      }]
    ]

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch (_) {}
    }

    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch (_) {}
      }
    }
  }, [isMiniPanel, togglePlay, previousTrack, nextTrack, seekTo, duration])

  // Escuchar cambios automáticos en la carpeta de música (Folder Watcher del backend)
  useEffect(() => {
    if (isMiniPanel || !window.electronAPI?.onLibraryUpdated) return
    const unsub = window.electronAPI.onLibraryUpdated((updatedTree) => {
      console.log('[Watcher] Biblioteca sincronizada automáticamente.')
      if (Array.isArray(updatedTree)) {
        setRawLibrary(updatedTree)
      }
    })
    return () => unsub()
  }, [isMiniPanel])

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

  // Escuchar comandos de hotkeys o de la ventana lateral / Game Overlay
  useEffect(() => {
    if (isMiniPanel || !window.electronAPI.onPlayerCommand) return

    const unsubCommand = window.electronAPI.onPlayerCommand((command) => {
      const cmd = typeof command === 'string' ? command : command?.type
      if (!cmd) return

      if (typeof cmd === 'string' && cmd.startsWith('select-')) {
        const idx = parseInt(cmd.replace('select-', ''), 10)
        if (!isNaN(idx) && playlist[idx]) {
          setPlaylistIndex(idx)
          playTrack(playlist[idx], currentAlbum, playlist, idx)
        }
        return
      }

      if (typeof cmd === 'string' && cmd.startsWith('seek-')) {
        const time = parseFloat(cmd.replace('seek-', ''))
        if (!isNaN(time)) {
          seekTo(time)
        }
        return
      }

      if (typeof cmd === 'string' && cmd.startsWith('volume-')) {
        const v = parseFloat(cmd.replace('volume-', ''))
        if (!isNaN(v)) {
          setVolumeLevel(v)
        }
        return
      }

      if (cmd === 'adjust-volume') {
        const delta = typeof command?.delta === 'number' ? command.delta : 0.05
        adjustVolume(delta)
        return
      }

      switch (cmd) {
        case 'next': nextTrack(); break
        case 'previous': previousTrack(); break
        case 'toggle-play': togglePlay(); break
        case 'toggle-shuffle': toggleShuffle(); break
        case 'toggle-loop': toggleLoop(); break
        case 'volume-up':
          adjustVolume(0.05)
          break
        case 'volume-down':
          adjustVolume(-0.05)
          break
        default: break
      }
    })
    return unsubCommand
  }, [isMiniPanel, playlist, currentAlbum, playTrack, seekTo, setVolumeLevel, adjustVolume, nextTrack, previousTrack, togglePlay, toggleShuffle, toggleLoop, volume])

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

  // Eliminar enlace duro de canción del disco (y el original en Canciones_reales si era su último enlace)
  const deleteTrackFromDisk = useCallback(async (track, options = {}) => {
    if (!track?.path) return { success: false }
    try {
      const info = getTrackAlbumInfo(track)
      const isLastAlbumLink = (info?.albumCount || 1) <= 1
      const forceDeleteMaster = Boolean(options.forceDeleteMaster ?? isLastAlbumLink)
      const skipScan = Boolean(options.skipScan)

      const audio = audioRef.current
      if (currentTrack && (currentTrack.id === track.id || currentTrack.path === track.path)) {
        const remaining = playlist.filter((t) => t.id !== track.id && t.path !== track.path)
        audio.pause()
        setIsPlaying(false)
        audio.removeAttribute('src')
        audio.load()
        // Breve espera para que Chromium y Windows liberen el handle de audio en disco
        await new Promise((r) => setTimeout(r, 40))
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
        forceDeleteMaster,
        skipScan,
        selectedDirectory: musicDirectory || undefined
      })

      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
      }
      return result || { success: false }
    } catch (err) {
      console.error('Error eliminando enlace de canción:', err)
      return { success: false, error: err.message }
    }
  }, [currentTrack, playlist, playlistIndex, musicDirectory, getTrackAlbumInfo])

  // Quitar una canción de un álbum específico (eliminando el Hard Link de la carpeta de ese álbum)
  const removeTrackFromAlbum = useCallback(async (track, targetAlbum) => {
    if (!track || !targetAlbum) return { success: false, error: 'Parámetros inválidos' }
    try {
      const info = getTrackAlbumInfo(track)
      const isLastAlbumLink = (info?.albumCount || 1) <= 1
      const targetAlbumPath = (targetAlbum.path || '').replace(/\\/g, '/').toLowerCase()
      const targetAlbumId = targetAlbum.id

      // 1. Buscar la copia exacta en ese álbum a través de copies
      const copy = (info?.copies || []).find((c) => {
        if (c.albumId && targetAlbumId && c.albumId === targetAlbumId) return true
        if (c.albumPath && targetAlbumPath) {
          const normCopyPath = c.albumPath.replace(/\\/g, '/').toLowerCase()
          return normCopyPath === targetAlbumPath
        }
        return false
      })

      let trackToDelete = copy?.track
      const copyPath = copy?.filePath || copy?.track?.path

      if (!trackToDelete && copyPath) {
        trackToDelete = { ...track, path: copyPath, id: copyPath }
      }

      // 2. Si no se encontró en info.copies, buscar en los tracks cargados del álbum destino
      if (!trackToDelete && targetAlbum.tracks) {
        const uniqueKey = track.uniqueKey || getTrackUniqueKey(track)
        trackToDelete = targetAlbum.tracks.find((t) => {
          const tKey = t.uniqueKey || getTrackUniqueKey(t)
          if (tKey && uniqueKey && tKey === uniqueKey) return true
          if (t.id === track.id) return true
          if (t.path && track.path && t.path.replace(/\\/g, '/').toLowerCase() === track.path.replace(/\\/g, '/').toLowerCase()) return true
          return false
        })
      }

      // 3. Si aún no se encontró, verificar si la ruta de track.path pertenece a targetAlbum.path
      if (!trackToDelete && track.path && targetAlbumPath) {
        const normTrackPath = track.path.replace(/\\/g, '/').toLowerCase()
        if (normTrackPath.startsWith(targetAlbumPath)) {
          trackToDelete = track
        }
      }

      // 4. Si coincide por nombre de archivo dentro de la carpeta del álbum destino
      if (!trackToDelete && targetAlbum.path && track.path) {
        const fileName = track.path.split(/[\\/]/).pop()
        if (fileName && targetAlbum.tracks) {
          trackToDelete = targetAlbum.tracks.find((t) => {
            const tFile = (t.path || '').split(/[\\/]/).pop()
            return tFile && fileName && tFile.toLowerCase() === fileName.toLowerCase()
          })
        }
      }

      // 5. Fallback si es el único álbum restante y tenemos la pista
      if (!trackToDelete && track.path) {
        trackToDelete = track
      }

      if (!trackToDelete || !trackToDelete.path) {
        return { success: false, error: 'No se encontró el enlace de la pista en el álbum indicado' }
      }

      return await deleteTrackFromDisk(trackToDelete, { forceDeleteMaster: isLastAlbumLink })
    } catch (err) {
      console.error('Error al quitar canción del álbum:', err)
      return { success: false, error: err.message }
    }
  }, [getTrackAlbumInfo, deleteTrackFromDisk])

  // Eliminar una canción de TODOS los álbumes donde exista (todos sus Hard Links + el archivo original en Canciones_reales)
  const deleteTrackFromAllAlbums = useCallback(async (track) => {
    if (!track) return { success: false }
    try {
      const info = getTrackAlbumInfo(track)
      const copies = info?.copies || []

      // Recopilar todas las rutas únicas a eliminar
      const pathsToDelete = new Set()
      if (track.path) pathsToDelete.add(track.path)
      for (const copy of copies) {
        const copyPath = copy.filePath || copy.track?.path
        if (copyPath) pathsToDelete.add(copyPath)
      }

      // Si la pista que se está reproduciendo coincide con alguna de las copias
      const audio = audioRef.current
      const isCurrentlyPlaying = currentTrack && (
        currentTrack.id === track.id ||
        pathsToDelete.has(currentTrack.path) ||
        copies.some((c) => (c.track?.id && c.track.id === currentTrack.id) || (c.filePath && c.filePath === currentTrack.path))
      )

      if (isCurrentlyPlaying) {
        const remaining = playlist.filter((t) => !pathsToDelete.has(t.path) && t.id !== track.id)
        audio.pause()
        setIsPlaying(false)
        audio.removeAttribute('src')
        audio.load()
        await new Promise((r) => setTimeout(r, 40))
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

      const pathsArray = Array.from(pathsToDelete)
      let lastResult = { success: true }
      for (let i = 0; i < pathsArray.length; i++) {
        const filePath = pathsArray[i]
        const isFinalLink = i === pathsArray.length - 1
        lastResult = await window.electronAPI.deleteTrackFile({
          filePath,
          forceDeleteMaster: isFinalLink,
          skipScan: !isFinalLink,
          selectedDirectory: musicDirectory || undefined
        })
      }

      if (lastResult && lastResult.success && Array.isArray(lastResult.library)) {
        setRawLibrary(lastResult.library)
      }

      return lastResult || { success: true }
    } catch (err) {
      console.error('Error al eliminar pista de todos los álbumes:', err)
      return { success: false, error: err.message }
    }
  }, [getTrackAlbumInfo, currentTrack, playlist, playlistIndex, musicDirectory])

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

  // Crear una nueva carpeta padre (carpeta contenedora de álbumes)
  const createFolder = useCallback(async (folderName, parentDir = null) => {
    if (!folderName || !window.electronAPI?.createFolder) return { success: false }
    try {
      const result = await window.electronAPI.createFolder({
        folderName,
        parentDir,
        selectedDirectory: musicDirectory || undefined
      })
      if (result && result.success && Array.isArray(result.library)) {
        setRawLibrary(result.library)
      }
      return result || { success: false }
    } catch (err) {
      console.error('Error creando carpeta padre:', err)
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

  // Editar información y etiquetas de una canción (Tag Editor ID3) en este y todos los demás álbumes donde exista
  const updateTrackTags = useCallback(async (track, newTags) => {
    if (!track?.path || !window.electronAPI?.updateTrackTags) {
      return { success: false, error: 'Ruta no válida o API no disponible' }
    }
    try {
      const info = getTrackAlbumInfo(track)
      const copies = info?.copies || []
      const pathsToUpdate = new Set()
      if (track.path) pathsToUpdate.add(track.path)
      for (const copy of copies) {
        if (copy.track?.path) pathsToUpdate.add(copy.track.path)
      }

      const res = await window.electronAPI.updateTrackTags({
        filePath: track.path,
        filePaths: Array.from(pathsToUpdate),
        title: newTags.title,
        artist: newTags.artist,
        album: newTags.album,
        selectedDirectory: musicDirectory || undefined
      })
      if (res && res.success) {
        if (Array.isArray(res.library)) {
          setRawLibrary(res.library)
        }
        if (currentTrack && (currentTrack.id === track.id || pathsToUpdate.has(currentTrack.path))) {
          setCurrentTrack((prev) => ({
            ...prev,
            title: newTags.title ? newTags.title.trim() : prev.title,
            artist: newTags.artist ? newTags.artist.trim() : prev.artist
          }))
        }
      }
      return res || { success: false }
    } catch (err) {
      console.error('Error al actualizar tags ID3:', err)
      return { success: false, error: err.message }
    }
  }, [musicDirectory, currentTrack, getTrackAlbumInfo])

  // Contexto de Biblioteca (cambia únicamente al escanear, crear/mover álbumes o seleccionar álbum)
  // Al aislarlo, componentes como Sidebar NO se re-renderizan con cambios de volumen, tiempo o play/pause
  const libraryValue = useMemo(() => ({
    library,
    allAlbums,
    allTracks,
    songAlbumsMap,
    getTrackAlbumInfo,
    addTrackToAlbums,
    removeTrackFromAlbum,
    deleteTrackFromDisk,
    deleteTrackFromAllAlbums,
    updateTrackTags,
    createAlbum,
    createFolder,
    moveAlbumFolder,
    renameAlbumFolder,
    deleteAlbumFolder,
    selectedAlbum,
    setSelectedAlbum,
    isLoading,
    musicDirectory,
    updateMusicDirectory,
    loadLibrary
  }), [
    library,
    allAlbums,
    allTracks,
    songAlbumsMap,
    getTrackAlbumInfo,
    addTrackToAlbums,
    removeTrackFromAlbum,
    deleteTrackFromDisk,
    deleteTrackFromAllAlbums,
    updateTrackTags,
    createAlbum,
    createFolder,
    moveAlbumFolder,
    renameAlbumFolder,
    deleteAlbumFolder,
    selectedAlbum,
    isLoading,
    musicDirectory,
    updateMusicDirectory,
    loadLibrary
  ])

  // Contexto de Reproducción (controles de audio, pista actual, cola, volumen y ecualizador)
  const playbackValue = useMemo(() => ({
    currentTrack,
    currentAlbum,
    playlist,
    playlistIndex,
    isPlaying,
    duration,
    volume,
    shuffle,
    loop,
    playTrack,
    togglePlay,
    nextTrack,
    previousTrack,
    seekTo,
    setVolumeLevel,
    adjustVolume,
    toggleShuffle,
    toggleLoop,
    playAlbum,
    analyserRef,
    audioContextRef,
    initAudioAnalyser,
    eqState,
    setEqBandGain,
    applyEqPreset,
    toggleEqEnabled,
    resetEq,
    EQ_FREQUENCIES,
    EQ_PRESETS,
    appSettings,
    updateAppSettings,
    currentLyrics,
    saveCurrentLyricsToDisk,
    deleteCurrentLyricsFromDisk,
    retryOnlineLyrics
  }), [
    currentTrack,
    currentAlbum,
    playlist,
    playlistIndex,
    isPlaying,
    duration,
    volume,
    shuffle,
    loop,
    playTrack,
    togglePlay,
    nextTrack,
    previousTrack,
    seekTo,
    setVolumeLevel,
    adjustVolume,
    toggleShuffle,
    toggleLoop,
    playAlbum,
    initAudioAnalyser,
    eqState,
    setEqBandGain,
    applyEqPreset,
    toggleEqEnabled,
    resetEq,
    appSettings,
    updateAppSettings,
    currentLyrics,
    saveCurrentLyricsToDisk,
    deleteCurrentLyricsFromDisk,
    retryOnlineLyrics
  ])

  // Contexto combinado para compatibilidad total con usePlayer()
  const playerValue = useMemo(() => ({
    ...libraryValue,
    ...playbackValue
  }), [libraryValue, playbackValue])

  // Contexto de tiempo de alta frecuencia: solo suscriben los componentes que dibujan el progreso
  const timeValue = useMemo(() => ({
    currentTime
  }), [currentTime])

  return (
    <LibraryContext.Provider value={libraryValue}>
      <PlaybackContext.Provider value={playbackValue}>
        <PlayerContext.Provider value={playerValue}>
          <PlayerTimeContext.Provider value={timeValue}>
            {children}
          </PlayerTimeContext.Provider>
        </PlayerContext.Provider>
      </PlaybackContext.Provider>
    </LibraryContext.Provider>
  )
}

export function useLibrary() {
  const context = useContext(LibraryContext)
  if (!context) {
    throw new Error('useLibrary debe usarse dentro de PlayerProvider')
  }
  return context
}

export function usePlayback() {
  const context = useContext(PlaybackContext)
  if (!context) {
    throw new Error('usePlayback debe usarse dentro de PlayerProvider')
  }
  return context
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
