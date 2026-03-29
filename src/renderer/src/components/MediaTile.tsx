import { useEffect, useState } from 'react'
import type { DbFile } from '../types'
import { toMediaUrl, toThumbnailUrl } from '../lib/media'
import HoverPreview from './HoverPreview'
import { useHoverPreview } from '../hooks/useHoverPreview'

export default function MediaTile({
  file,
  rootPath,
}: {
  file: DbFile
  rootPath: string
}): JSX.Element {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const isVideo = file.media_type === 'video'
  const fullUrl = toMediaUrl(rootPath, file.path)

  const {
    elementRef,
    layout,
    preview,
    handleMouseEnter,
    handleMouseLeave,
    handleNaturalSize,
  } = useHoverPreview()

  useEffect(() => {
    window.api.getThumbnailPath(file.content_hash).then((absPath) => {
      if (absPath) setThumbUrl(toThumbnailUrl(absPath))
    })
  }, [file.content_hash])

  return (
    <>
      <div
        ref={elementRef as React.RefObject<HTMLDivElement>}
        className="group relative overflow-hidden rounded-lg bg-neutral-800 cursor-pointer"
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