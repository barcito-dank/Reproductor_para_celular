import { useEffect, useRef, useState } from 'react'

function ToastNotification() {
  const [track, setTrack] = useState(null)
  const [animState, setAnimState] = useState('hidden')
  const hideTimeoutRef = useRef(null)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'

    const unsubscribeShow = window.electronAPI.onToastNotification((incomingTrack) => {
      if (!incomingTrack) return
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      setTrack(incomingTrack)
      setAnimState('entering')
    })

    const unsubscribeHide = window.electronAPI.onHideToastNotification(() => {
      setAnimState('exiting')
      hideTimeoutRef.current = setTimeout(() => {
        setAnimState('hidden')
        hideTimeoutRef.current = null
      }, 420)
    })

    return () => {
      unsubscribeShow()
      unsubscribeHide()
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    }
  }, [])

  if (animState === 'hidden' || !track) return null

  return (
    <div className={`toast-balloon-wrapper ${animState === 'exiting' ? 'fade-out' : 'descend'}`}>
      <div className="toast-balloon-card">
        <div className="toast-balloon-cover" key={track.cover || 'no-cover'}>
          {track.cover ? (
            <>
              <img
                src={track.cover}
                alt=""
                className="toast-balloon-cover-img"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                  const fb = e.currentTarget.parentElement?.querySelector('.toast-balloon-placeholder')
                  if (fb) fb.style.display = 'flex'
                }}
              />
              <div className="toast-balloon-placeholder" style={{ display: 'none' }}>🎵</div>
            </>
          ) : (
            <div className="toast-balloon-placeholder">🎵</div>
          )}
        </div>

        <div className="toast-balloon-details">
          <div className="toast-balloon-title" title={track.title}>
            {track.title}
          </div>
          <div className="toast-balloon-artist" title={track.artist || 'Artista Desconocido'}>
            {track.artist || 'Artista Desconocido'}
          </div>
        </div>

        <div className="toast-balloon-eq">
          <span className="balloon-eq-bar b-bar-1" />
          <span className="balloon-eq-bar b-bar-2" />
          <span className="balloon-eq-bar b-bar-3" />
        </div>
      </div>
    </div>
  )
}

export default ToastNotification
