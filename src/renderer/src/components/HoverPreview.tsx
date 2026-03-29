import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DbFile } from '../types'

export default function HoverPreview({
  file,
  fullUrl,
  thumbUrl,
  x,
  y,
  width,
  height,
  onNaturalSize,
}: {
  file: DbFile
  fullUrl: string
  thumbUrl: string | null
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

  useEffect(() => {
    if (videoRef.current) videoRef.current.play()
  }, [])

  const handleVideoReady = () => {
    const v = videoRef.current
    if (v?.videoWidth && v?.videoHeight) onNaturalSize(v.videoWidth, v.videoHeight)
    setReady(true)
  }

  const handleImgLoad = () => {
    const i = imgRef.current
    if (i) onNaturalSize(i.naturalWidth, i.naturalHeight)
    setReady(true)
  }

  const mediaStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  }

  return createPortal(
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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {isVideo ? (
        <video
          ref={videoRef}
          src={fullUrl}
          muted
          loop
          playsInline
          autoPlay
          onCanPlay={handleVideoReady}
          onError={(e) => console.error('video error:', file.filename, e)}
          style={mediaStyle}
        />
      ) : (
        <img
          ref={imgRef}
          src={isGif ? fullUrl : (thumbUrl ?? fullUrl)}
          alt={file.filename}
          onLoad={handleImgLoad}
          style={mediaStyle}
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
    </div>,
    document.body
  )
}