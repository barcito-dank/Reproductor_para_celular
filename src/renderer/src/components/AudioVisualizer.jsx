import React, { useEffect, useRef } from 'react'
import { usePlayback } from '../context/PlayerContext'

/**
 * Visualizador de Espectro de Audio Real basado en Web Audio API
 * Analiza frecuencias reales de la música mediante AnalyserNode y dibuja
 * barras reactivas con gradiente neón y picos flotantes con gravedad.
 */
function AudioVisualizer({ height = 54, barCount = 36, isCompact = false }) {
  const { analyserRef, audioContextRef, isPlaying, currentTrack, initAudioAnalyser } = usePlayback()
  const canvasRef = useRef(null)
  const animFrameRef = useRef(null)
  const isPlayingRef = useRef(isPlaying)
  const peaksRef = useRef([])           // Puntos flotantes superiores con gravedad
  const currentHeightsRef = useRef([])  // Alturas suavizadas (Attack / Decay)
  const drawRef = useRef(null)          // Función render actual
  const startLoopRef = useRef(null)     // Arrancador del loop rAF
  const gradientRef = useRef(null)      // Gradiente cacheado
  const peakColorRef = useRef('#22d3ee')
  const widthRef = useRef(0)            // Ancho CSS cacheado del canvas
  const dataArrayRef = useRef(null)     // Uint8Array reutilizado
  const bufferLengthRef = useRef(0)
  const isWindowVisibleRef = useRef(!document.hidden)

  // Mantener siempre sincronizada la referencia en vivo de isPlaying (evita closures obsoletos)
  isPlayingRef.current = isPlaying

  const hasResidualDecay = () => {
    const heights = currentHeightsRef.current
    const peaks = peaksRef.current
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] > 4.05 || (peaks[i] ?? 4) > 4.05) {
        return true
      }
    }
    return false
  }

  useEffect(() => {
    if (!isPlaying) return
    initAudioAnalyser()
    if (audioContextRef?.current?.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {})
    }
  }, [initAudioAnalyser, isPlaying, currentTrack, audioContextRef])

  // ------------------------------------------------------------------
  // Efecto A: setup (canvas, observer de tamaño y de data-theme, arrays, gradiente).
  // ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    peaksRef.current = new Array(barCount).fill(4)
    currentHeightsRef.current = new Array(barCount).fill(4)
    dataArrayRef.current = null
    bufferLengthRef.current = 0

    const rebuildGradient = () => {
      const isLight = document.documentElement.dataset.theme === 'light'
      const g = ctx.createLinearGradient(0, height, 0, 0)
      if (isLight) {
        g.addColorStop(0, '#4f46e5')    // Índigo intenso base
        g.addColorStop(0.45, '#7c3aed') // Violeta vibrante
        g.addColorStop(0.8, '#db2777')  // Fucsia intenso
        g.addColorStop(1, '#0891b2')    // Cian profundo en picos
        peakColorRef.current = '#0891b2'
      } else {
        g.addColorStop(0, '#6366f1')    // Violeta / Índigo base
        g.addColorStop(0.4, '#a855f7')  // Morado neón
        g.addColorStop(0.75, '#ec4899') // Rosa fucsia
        g.addColorStop(1, '#22d3ee')    // Cian eléctrico en picos
        peakColorRef.current = '#22d3ee'
      }
      gradientRef.current = g
    }

    // ------------------------------------------------------------------
    // Función de dibujo. Retorna true si aún hay movimiento activo (reproduciendo o decayendo).
    // ------------------------------------------------------------------
    const draw = (advancePhysics) => {
      const width = widthRef.current
      const drawHeight = height
      if (width <= 0) return false

      ctx.clearRect(0, 0, width, drawHeight)

      const playingNow = isPlayingRef.current
      let analyser = analyserRef.current
      if (!analyser && playingNow) {
        analyser = initAudioAnalyser()
      }

      if (playingNow && audioContextRef?.current?.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {})
      }

      let dataArray = dataArrayRef.current
      let bufferLength = bufferLengthRef.current

      if (analyser) {
        const bl = analyser.frequencyBinCount
        if (!dataArray || bufferLength !== bl) {
          dataArray = new Uint8Array(bl)
          dataArrayRef.current = dataArray
          bufferLengthRef.current = bl
        }
        bufferLength = bl
        if (playingNow && advancePhysics) {
          analyser.getByteFrequencyData(dataArray)
        }
      }

      const totalBars = barCount
      const gap = isCompact ? 3 : 5
      const totalGaps = (totalBars - 1) * gap
      const barWidth = Math.max(3, (width - totalGaps) / totalBars)

      if (peaksRef.current.length !== totalBars) {
        peaksRef.current = new Array(totalBars).fill(4)
      }
      if (currentHeightsRef.current.length !== totalBars) {
        currentHeightsRef.current = new Array(totalBars).fill(4)
      }

      const peaks = peaksRef.current
      const currentHeights = currentHeightsRef.current
      if (!gradientRef.current) rebuildGradient()
      const gradient = gradientRef.current
      const peakColor = peakColorRef.current
      const radius = Math.min(barWidth / 2, 4)

      let hasMotion = playingNow
      let hasHalos = false
      let hasPeaks = false

      for (let i = 0; i < totalBars; i++) {
        const ratio = i / totalBars
        const freqIndex = bufferLength > 0
          ? Math.min(
              bufferLength - 1,
              Math.floor(Math.pow(ratio, 1.25) * (bufferLength * 0.85))
            )
          : 0

        let rawVal = 0
        if (analyser && dataArray && playingNow && advancePhysics) {
          const startBin = Math.max(0, freqIndex - 1)
          const endBin = Math.min(bufferLength - 1, freqIndex + 1)
          let sum = 0
          let cnt = 0
          for (let b = startBin; b <= endBin; b++) {
            sum += dataArray[b]
            cnt++
          }
          rawVal = cnt > 0 ? sum / cnt : (dataArray[freqIndex] || 0)
        }

        const trebleCompensation = 1 + Math.pow(ratio, 0.75) * 0.75
        const normalized = (rawVal / 255) * trebleCompensation
        const boosted = Math.pow(Math.min(1.25, normalized), 0.68) * 1.40
        const percent = Math.min(1, Math.max(0, boosted))

        const maxBarHeight = drawHeight - 6
        const targetBarHeight = playingNow ? Math.max(4, percent * maxBarHeight) : 4

        let smoothH
        if (advancePhysics) {
          const prevH = currentHeights[i] ?? 4
          if (targetBarHeight > prevH) {
            smoothH = prevH + (targetBarHeight - prevH) * 0.46
          } else {
            smoothH = prevH + (targetBarHeight - prevH) * 0.22
          }
          if (smoothH < 4.05) smoothH = 4
          currentHeights[i] = smoothH

          if (smoothH >= peaks[i]) {
            peaks[i] = smoothH
          } else {
            peaks[i] = Math.max(4, peaks[i] - 1.3)
          }

          if (smoothH > 4.05 || peaks[i] > 4.05) {
            hasMotion = true
          }
        } else {
          smoothH = currentHeights[i] ?? 4
        }

        if (smoothH > 8) hasHalos = true
        if (!isCompact && peaks[i] > 6) hasPeaks = true
      }

      // 1. Pase agrupado de halos (1 sola llamada de dibujo GPU)
      if (hasHalos) {
        ctx.globalAlpha = 0.22
        ctx.fillStyle = gradient
        ctx.beginPath()
        for (let i = 0; i < totalBars; i++) {
          const smoothH = currentHeights[i] ?? 4
          if (smoothH > 8) {
            const x = i * (barWidth + gap)
            const y = drawHeight - smoothH
            ctx.rect(x - 1, Math.max(0, y - 1), barWidth + 2, smoothH + 1)
          }
        }
        ctx.fill()
        ctx.globalAlpha = 1
      }

      // 2. Pase agrupado de barras principales (1 sola llamada de dibujo GPU)
      ctx.fillStyle = gradient
      ctx.beginPath()
      for (let i = 0; i < totalBars; i++) {
        const smoothH = currentHeights[i] ?? 4
        const x = i * (barWidth + gap)
        const y = drawHeight - smoothH
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barWidth, smoothH, [radius, radius, 1, 1])
        } else {
          ctx.rect(x, y, barWidth, smoothH)
        }
      }
      ctx.fill()

      // 3. Pase agrupado de picos flotantes (1 sola llamada de dibujo GPU)
      if (hasPeaks) {
        ctx.fillStyle = peakColor
        ctx.beginPath()
        for (let i = 0; i < totalBars; i++) {
          if (peaks[i] > 6) {
            const x = i * (barWidth + gap)
            const peakY = drawHeight - peaks[i] - 3
            ctx.rect(x, Math.max(0, peakY), barWidth, 2)
          }
        }
        ctx.fill()
      }

      return hasMotion
    }

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = rect.width * dpr
        canvas.height = height * dpr
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        widthRef.current = rect.width
        rebuildGradient()
        draw(false)
      }
    }

    drawRef.current = draw
    resizeCanvas()

    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(canvas)

    // Observar cambios de tema (data-theme='light' / 'dark') para actualizar el gradiente al instante
    const themeObserver = new MutationObserver(() => {
      rebuildGradient()
      draw(false)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    if (isPlayingRef.current && startLoopRef.current) {
      startLoopRef.current()
    }

    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
      drawRef.current = null
      gradientRef.current = null
      dataArrayRef.current = null
      bufferLengthRef.current = 0
    }
  }, [analyserRef, audioContextRef, initAudioAnalyser, height, barCount, isCompact])

  // ------------------------------------------------------------------
  // Efecto B: control del rAF. Corre solo cuando la ventana es visible y (isPlaying o decaimiento activo).
  // ------------------------------------------------------------------
  useEffect(() => {
    let lastFrameTime = 0
    const TARGET_FRAME_MS = 1000 / 60 // ~60 FPS

    const isVisible = () => !document.hidden && isWindowVisibleRef.current

    const stop = () => {
      if (animFrameRef.current != null) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }

    const tick = (now) => {
      animFrameRef.current = null
      if (!drawRef.current || !isVisible()) return

      const elapsed = now - lastFrameTime
      let keepRunning = isPlayingRef.current
      if (elapsed >= TARGET_FRAME_MS) {
        lastFrameTime = now - (elapsed % TARGET_FRAME_MS)
        keepRunning = drawRef.current(true)
      } else {
        keepRunning = isPlayingRef.current || hasResidualDecay()
      }

      if ((isPlayingRef.current || keepRunning) && isVisible() && drawRef.current) {
        animFrameRef.current = requestAnimationFrame(tick)
      }
    }

    const start = () => {
      if (!isVisible()) {
        stop()
        return
      }
      if (!isPlayingRef.current && !hasResidualDecay()) {
        stop()
        drawRef.current?.(false)
        return
      }
      if (animFrameRef.current == null) {
        lastFrameTime = performance.now() - TARGET_FRAME_MS
        animFrameRef.current = requestAnimationFrame(tick)
      }
    }

    startLoopRef.current = start

    const onVisibility = () => {
      if (!isVisible()) {
        stop()
      } else {
        start()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    let unsubMainVisibility = null
    if (window.electronAPI?.onMainWindowVisibility) {
      unsubMainVisibility = window.electronAPI.onMainWindowVisibility((visible) => {
        isWindowVisibleRef.current = Boolean(visible)
        onVisibility()
      })
    }

    start()

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (unsubMainVisibility) unsubMainVisibility()
      startLoopRef.current = null
      stop()
    }
  }, [isPlaying, currentTrack])

  return (
    <div className={`audio-visualizer-container ${isCompact ? 'compact' : ''}`}>
      <canvas
        ref={canvasRef}
        className="audio-visualizer-canvas"
        style={{ height: `${height}px` }}
      />
    </div>
  )
}

export default React.memo(AudioVisualizer)