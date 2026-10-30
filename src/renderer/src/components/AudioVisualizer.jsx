import { useEffect, useRef } from 'react'
import { usePlayer } from '../context/PlayerContext'

/**
 * Visualizador de Espectro de Audio Real basado en Web Audio API
 * Analiza frecuencias reales de la música mediante AnalyserNode y dibuja
 * barras reactivas con gradiente neón y picos flotantes con gravedad.
 *
 * Optimización: el rAF solo corre cuando isPlaying && !document.hidden.
 * Al pausar se dibuja un frame estático y se cancela el loop.
 */
function AudioVisualizer({ height = 54, barCount = 36, isCompact = false }) {
  const { analyserRef, isPlaying, initAudioAnalyser } = usePlayer()
  const canvasRef = useRef(null)
  const animFrameRef = useRef(null)
  const peaksRef = useRef([])           // Puntos flotantes superiores con gravedad
  const currentHeightsRef = useRef([])  // Alturas suavizadas (Attack / Decay)
  const drawRef = useRef(null)          // Última función render (para frame estático)
  const gradientRef = useRef(null)      // Gradiente cacheado (depende solo de height)
  const widthRef = useRef(0)            // Ancho CSS cacheado del canvas
  const dataArrayRef = useRef(null)     // Uint8Array reutilizado
  const bufferLengthRef = useRef(0)

  useEffect(() => {
    initAudioAnalyser()
  }, [initAudioAnalyser])

  // ------------------------------------------------------------------
  // Efecto A: setup (canvas, observer, arrays, gradiente). No depende de isPlaying.
  // ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Inicializar estado interno
    peaksRef.current = new Array(barCount).fill(4)
    currentHeightsRef.current = new Array(barCount).fill(4)
    dataArrayRef.current = null
    bufferLengthRef.current = 0

    const rebuildGradient = () => {
      const g = ctx.createLinearGradient(0, height, 0, 0)
      g.addColorStop(0, '#6366f1')    // Violeta / Índigo base
      g.addColorStop(0.4, '#a855f7')  // Morado neón
      g.addColorStop(0.75, '#ec4899') // Rosa fucsia
      g.addColorStop(1, '#22d3ee')    // Cian eléctrico en picos
      gradientRef.current = g
    }

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = rect.width * dpr
        canvas.height = height * dpr
        // Reset transform antes de escalar para evitar acumulación en resizes
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        widthRef.current = rect.width
        rebuildGradient()
      }
    }

    resizeCanvas()
    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(canvas)

    // ------------------------------------------------------------------
    // Función de dibujo. NO se auto-agenda; el efecto B controla el rAF.
    // advancePhysics=false dibuja el estado actual sin moverlo (frame estático).
    // ------------------------------------------------------------------
    const draw = (advancePhysics) => {
      const width = widthRef.current
      const drawHeight = height
      if (width <= 0) return

      ctx.clearRect(0, 0, width, drawHeight)

      const analyser = analyserRef.current
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
        if (isPlaying && advancePhysics) {
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
      const gradient = gradientRef.current

      for (let i = 0; i < totalBars; i++) {
        const ratio = i / totalBars
        const freqIndex = Math.min(
          bufferLength - 1,
          Math.floor(Math.pow(ratio, 1.25) * (bufferLength * 0.85))
        )

        let rawVal = 0
        if (analyser && dataArray && isPlaying && advancePhysics) {
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
        const targetBarHeight = Math.max(4, percent * maxBarHeight)

        let smoothH
        if (advancePhysics) {
          const prevH = currentHeights[i] ?? 4
          if (targetBarHeight > prevH) {
            smoothH = prevH + (targetBarHeight - prevH) * 0.46
          } else {
            smoothH = prevH + (targetBarHeight - prevH) * 0.20
          }
          currentHeights[i] = smoothH

          if (smoothH >= peaks[i]) {
            peaks[i] = smoothH
          } else {
            peaks[i] = Math.max(4, peaks[i] - 1.3)
          }
        } else {
          smoothH = currentHeights[i] ?? 4
        }

        const x = i * (barWidth + gap)
        const y = drawHeight - smoothH

        // Dibujo directo sin ctx.shadowBlur (el resplandor se delega a CSS con aceleración GPU)
        ctx.fillStyle = gradient
        const radius = Math.min(barWidth / 2, 4)
        ctx.beginPath()
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barWidth, smoothH, [radius, radius, 1, 1])
        } else {
          ctx.rect(x, y, barWidth, smoothH)
        }
        ctx.fill()

        if (!isCompact && peaks[i] > 6) {
          const peakY = drawHeight - peaks[i] - 3
          ctx.fillStyle = '#22d3ee'
          ctx.fillRect(x, Math.max(0, peakY), barWidth, 2)
        }
      }
    }

    drawRef.current = draw

    // Frame estático inicial (música pausada / montaje)
    draw(false)

    return () => {
      resizeObserver.disconnect()
      drawRef.current = null
      gradientRef.current = null
      dataArrayRef.current = null
      bufferLengthRef.current = 0
    }
  }, [analyserRef, height, barCount, isCompact])

  // ------------------------------------------------------------------
  // Efecto B: control del rAF. Solo corre si isPlaying && !document.hidden.
  // Optimización: limitado a 60 FPS para no desperdiciar GPU en monitores 144Hz/240Hz.
  // Al pausar/ocultar, cancela el frame pendiente y dibuja un frame estático.
  // ------------------------------------------------------------------
  useEffect(() => {
    let lastFrameTime = 0
    const TARGET_FRAME_MS = 1000 / 60 // ~60 FPS

    const stop = () => {
      if (animFrameRef.current != null) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }

    const tick = (now) => {
      animFrameRef.current = null
      if (!drawRef.current) return

      const elapsed = now - lastFrameTime
      if (elapsed >= TARGET_FRAME_MS) {
        lastFrameTime = now - (elapsed % TARGET_FRAME_MS)
        drawRef.current(true)
      }

      // Reagendar solo si seguimos reproduciendo y visibles
      if (isPlaying && !document.hidden && drawRef.current) {
        animFrameRef.current = requestAnimationFrame(tick)
      }
    }

    const start = () => {
      stop()
      lastFrameTime = performance.now()
      if (!drawRef.current) return
      if (!isPlaying || document.hidden) {
        // Frame estático: conserva la última visualización sin mover la física
        drawRef.current(false)
        return
      }
      animFrameRef.current = requestAnimationFrame(tick)
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        start()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    start()

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [isPlaying])

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

export default AudioVisualizer