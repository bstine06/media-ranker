import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DbFile } from '@renderer/shared/types/types'

export default function HoverPreview({
  file,
  fullUrl,
  x,
  y,
  width,
  height,
  onNaturalSize,
}: {
  file: DbFile
  fullUrl: string
  x: number
  y: number
  width: number
  height: number
  onNaturalSize: (w: number, h: number) => void
}): JSX.Element {
  const isVideo = file.media_type === 'video'
  const isGif = file.media_type === 'gif'
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [ready, setReady] = useState(false)
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setReady(false)

    // Track cursor for loading indicator
    const handleMouseMove = (e: MouseEvent) => {
      setCursorPos({ x: e.clientX, y: e.clientY })
    }
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [file.content_hash])

  useEffect(() => {
    if (videoRef.current) videoRef.current.play()
  }, [])

  const handleVideoReady = () => {
    const v = videoRef.current
    if (v?.videoWidth && v?.videoHeight) onNaturalSize(v.videoWidth, v.videoHeight)
    setReady(true)
  }

  const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const i = e.currentTarget
    onNaturalSize(i.naturalWidth, i.naturalHeight)
    setReady(true)
  }

  return createPortal(
    <>
      {/* Loading spinner near cursor */}
      {!ready && cursorPos && (
        <div
          style={{
            position: 'fixed',
            left: cursorPos.x + 16,
            top: cursorPos.y + 16,
            zIndex: 100,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: 20,
              height: 20,
              border: '2px solid rgba(255,255,255,0.2)',
              borderTopColor: 'white',
              borderRadius: '50%',
              animation: 'spin 0.6s linear infinite',
            }}
          />
        </div>
      )}

      {/* Preview container */}
      <div
        className="fixed z-50 rounded-xl shadow-2xl border border-neutral-700 bg-neutral-900"
        style={{
          left: x,
          top: y,
          width,
          height,
          opacity: ready ? 1 : 0,
          transition: 'opacity 0.2s ease',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        {isVideo ? (
          <video
            ref={videoRef}
            src={fullUrl}
            loop
            playsInline
            autoPlay
            onCanPlay={handleVideoReady}
            onError={(e) => console.error('video error:', file.filename, e)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <img
            ref={imgRef}
            src={fullUrl}
            alt={file.filename}
            onLoad={handleImgLoad}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}

        {ready && (
          <div
            className="absolute bottom-0 left-0 right-0 px-3 py-2"
            style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.7))' }}
          >
            <p className="truncate text-xs font-medium text-white">{file.filename}</p>
            <p className="text-xs text-neutral-400">
              {Math.round(file.elo_score)} pts · {file.media_type}
            </p>
          </div>
        )}
      </div>
    </>,
    document.body
  )
}