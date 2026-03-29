import { useEffect, useRef, useState, useCallback } from 'react'
import type { DbFile } from '../types'
import { toMediaUrl, toThumbnailUrl } from '../lib/media'
import HoverPreview from './HoverPreview'

interface PreviewState {
  anchorY: number
  tileRight: number
  tileLeft: number
  naturalW: number | null
  naturalH: number | null
}

function computePreviewLayout(state: PreviewState): {
  x: number
  y: number
  width: number
  height: number
} {
  const maxW = window.innerWidth * 0.75
  const maxH = window.innerHeight * 0.75

  const natW = state.naturalW ?? 1600
  const natH = state.naturalH ?? 900

  const scale = Math.min(maxW / natW, maxH / natH)
  const width = natW * scale
  const height = natH * scale

  const spaceRight = window.innerWidth - state.tileRight
  const x = spaceRight > width + 16
    ? state.tileRight + 8
    : state.tileLeft - width - 8

  const y = Math.min(state.anchorY, window.innerHeight - height - 16)
  const clampedX = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const clampedY = Math.max(8, y)

  return { x: clampedX, y: clampedY, width, height }
}

export default function MediaTile({
  file,
  rootPath,
}: {
  file: DbFile
  rootPath: string
}): JSX.Element {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewRef = useRef<PreviewState | null>(null)
  const tileRef = useRef<HTMLDivElement>(null)
  const isVideo = file.media_type === 'video'
  const fullUrl = toMediaUrl(rootPath, file.path)

  useEffect(() => {
    window.api.getThumbnailPath(file.content_hash).then((absPath) => {
      if (absPath) setThumbUrl(toThumbnailUrl(absPath))
    })
  }, [file.content_hash])

  const handleMouseEnter = () => {
    const rect = tileRef.current?.getBoundingClientRect()
    if (!rect) return
    hoverTimer.current = setTimeout(() => {
      const state: PreviewState = {
        anchorY: rect.top,
        tileRight: rect.right,
        tileLeft: rect.left,
        naturalW: null,
        naturalH: null,
      }
      previewRef.current = state
      setPreview(state)
    }, 200)
  }

  const handleMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    previewRef.current = null
    setPreview(null)
  }

  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (!previewRef.current) return
    const updated = { ...previewRef.current, naturalW: w, naturalH: h }
    previewRef.current = updated
    setPreview(updated)
  }, [])

  const layout = preview ? computePreviewLayout(preview) : null

  return (
    <>
      <div
        ref={tileRef}
        className="group relative aspect-square overflow-hidden rounded-lg bg-neutral-800 cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={file.filename}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-neutral-600 text-xs">
            {isVideo ? '▶' : '?'}
          </div>
        )}

        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <p className="truncate text-xs font-medium text-white">{file.filename}</p>
          <p className="text-xs text-neutral-400">{Math.round(file.elo_score)} pts</p>
        </div>

        {isVideo && (
          <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">▶</div>
        )}
        {file.media_type === 'gif' && (
          <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">GIF</div>
        )}
      </div>

      {preview && layout && (
        <HoverPreview
          file={file}
          fullUrl={fullUrl}
          thumbUrl={thumbUrl}
          x={layout.x}
          y={layout.y}
          width={layout.width}
          height={layout.height}
          onNaturalSize={handleNaturalSize}
        />
      )}
    </>
  )
}