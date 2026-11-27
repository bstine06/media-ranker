import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { DbFile } from '@renderer/shared/types/types'
import { useLibraryRank } from '@renderer/contexts/RankContext'
import { turnedSize } from "@renderer/lib/turn"
import { MediaSpot } from "@renderer/media/MediaLayer"

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
  // The media is a spot: the file's one player (media layer), drawn turned
  // by its rotation setting; the box takes the turned shape. It's the
  // focused player while it shows (Q / E, hold 4, P, its bar), heard, and
  // never takes the mouse (that's on the tile). G flies it to the file view.
  const rotation = file.rotation ?? 0
  const libraryRank = useLibraryRank(file.id)
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

  // The media's own shape, unturned; the box takes it turned, and again
  // whenever the turn changes (R while it shows).
  const [aspect, setAspect] = useState<number | null>(null)
  const handleAspect = (a: number) => setAspect(a)
  useEffect(() => {
    if (aspect !== null) onNaturalSize(...turnedSize(rotation, aspect * 1000, 1000))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect, rotation])

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
        className="fixed z-50 shadow-2xl border border-neutral-700 bg-neutral-900"
        style={{
          left: x,
          top: y,
          width,
          height,
          opacity: ready ? 1 : 0,
          transition: 'opacity 0.1s ease',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        <MediaSpot
          file={file}
          className="absolute inset-0"
          player={{
            focused: true,
            muted: false,
            inert: true,
            clickToPauseEnabled: false,
            keyboardEnabled: false,
            rotation,
            onReady: () => setReady(true),
            onAspect: handleAspect,
          }}
        />
        {ready && libraryRank && (
          <div
            className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white"
            title="Place in the whole library"
          >
            {libraryRank}
          </div>
        )}
      </div>
    </>,
    document.body
  )
}