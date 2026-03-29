import { useEffect, useState, useCallback, useRef } from "react";
import type { DbFile } from "../types";
import { toMediaUrl, toThumbnailUrl } from "../lib/media";
import { useKeyboardShortcut } from "../hooks/useKeyboard";

export default function CompareView({
    rootPath,
    folderPrefixes,
}: {
    rootPath: string;
    folderPrefixes: string[] | null;
}): JSX.Element {
    const [pair, setPair] = useState<[DbFile, DbFile] | null>(null);
    const [loading, setLoading] = useState(true);
    const [comparing, setComparing] = useState(false);
    const [stats, setStats] = useState({ comparisons: 0 });
    const [hoveredSide, setHoveredSide] = useState<"a" | "b" | null>(null);

    const preloadFile = (file: DbFile) => {
        const url = toMediaUrl(rootPath, file.path);
        if (file.media_type !== "video") {
            const img = new Image();
            img.src = url;
        }
    };

    const loadPair = useCallback(async () => {
        setLoading(true);
        const result = await window.api.getPair(folderPrefixes);
        setPair(result);
        setLoading(false);

        // Preload next pair in background while user decides
        window.api.getPair(folderPrefixes).then((next) => {
            if (next) {
                preloadFile(next[0]);
                preloadFile(next[1]);
            }
        });
    }, [folderPrefixes, rootPath]);

    useEffect(() => {
        loadPair();
    }, [loadPair]);

    const handlePick = useCallback(
        async (winnerId: number, loserId: number) => {
            if (comparing) return;
            setComparing(true);
            setHoveredSide(null);
            await window.api.recordComparison(winnerId, loserId);
            setStats((s) => ({ comparisons: s.comparisons + 1 }));
            await loadPair();
            setComparing(false);
        },
        [comparing, loadPair],
    );

    const handleSkip = useCallback(() => {
        setHoveredSide(null);
        loadPair();
    }, [loadPair]);

    const handleLeft = useCallback(() => {
        if (!pair || comparing) return;
        if (hoveredSide === "a") {
            const [a, b] = pair;
            handlePick(a.id, b.id);
        } else {
            setHoveredSide("a");
        }
    }, [pair, comparing, hoveredSide, handlePick]);

    const handleRight = useCallback(() => {
        if (!pair || comparing) return;
        if (hoveredSide === "b") {
            const [a, b] = pair;
            handlePick(b.id, a.id);
        } else {
            setHoveredSide("b");
        }
    }, [pair, comparing, hoveredSide, handlePick]);

    useKeyboardShortcut({ key: "ArrowLeft", onKeyPressed: handleLeft });
    useKeyboardShortcut({ key: "ArrowRight", onKeyPressed: handleRight });

    if (loading) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Loading…
            </div>
        );
    }

    if (!pair) {
        return (
            <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
                Not enough files to compare. Add more media to your library.
            </div>
        );
    }

    const [a, b] = pair;

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
                <h2 className="text-sm font-medium text-neutral-300">
                    Compare
                </h2>
                <div className="flex items-center gap-4">
                    <span className="text-xs text-neutral-600">
                        {stats.comparisons} comparisons this session
                    </span>
                    <button
                        onClick={handleSkip}
                        className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                    >
                        Skip →
                    </button>
                </div>
            </div>

            <div className="flex flex-1 gap-3 p-4 overflow-hidden">
                <CompareCard
                    file={a}
                    rootPath={rootPath}
                    onPick={() => handlePick(a.id, b.id)}
                    disabled={comparing}
                    forceHover={hoveredSide === "a"}
                    onMouseEnter={() => setHoveredSide("a")}
                    onMouseLeave={() => setHoveredSide(null)}
                />
                <CompareCard
                    file={b}
                    rootPath={rootPath}
                    onPick={() => handlePick(b.id, a.id)}
                    disabled={comparing}
                    forceHover={hoveredSide === "b"}
                    onMouseEnter={() => setHoveredSide("b")}
                    onMouseLeave={() => setHoveredSide(null)}
                />
            </div>
        </div>
    );
}

function CompareCard({
  file,
  rootPath,
  onPick,
  disabled,
  forceHover,
  onMouseEnter,
  onMouseLeave,
}: {
  file: DbFile
  rootPath: string
  onPick: () => void
  disabled: boolean
  forceHover: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [mouseHover, setMouseHover] = useState(false)
  const hovered = forceHover || mouseHover
  const isVideo = file.media_type === 'video'
  const isGif = file.media_type === 'gif'
  const fullUrl = toMediaUrl(rootPath, file.path)

  useEffect(() => {
    setThumbUrl(null)
    setPreviewUrl(null)
    setFullLoaded(false)

    window.api.getThumbnailPath(file.content_hash).then((absPath) => {
      if (absPath) setThumbUrl(toThumbnailUrl(absPath))
    })

    window.api.getPreviewPath(file.content_hash).then((absPath) => {
      if (absPath) setPreviewUrl(toThumbnailUrl(absPath))
    })
  }, [file.content_hash])

  // Preload preview in background
  useEffect(() => {
    if (!previewUrl || isVideo || isGif) return
    const img = new Image()
    img.src = previewUrl
    img.onload = () => setFullLoaded(true)
  }, [previewUrl, isVideo, isGif])

  return (
    <div
      className={`relative flex flex-1 flex-col overflow-hidden rounded-xl border-2 transition-all cursor-pointer
        ${disabled
          ? 'border-neutral-800 opacity-60'
          : hovered
            ? 'border-white'
            : 'border-neutral-700'
        }`}
      onClick={onPick}
      onMouseEnter={() => { setMouseHover(true); onMouseEnter() }}
      onMouseLeave={() => { setMouseHover(false); onMouseLeave() }}
    >
      <div className="relative flex-1 overflow-hidden bg-neutral-900">
        {isVideo ? (
          <video
            src={fullUrl}
            className="h-full w-full object-contain"
            muted={!hovered}
            loop
            playsInline
            autoPlay
          />
        ) : (
          <>
            {/* Blurred thumbnail shown instantly */}
            {thumbUrl && (
              <img
                src={thumbUrl}
                alt={file.filename}
                className="absolute inset-0 h-full w-full object-contain transition-opacity duration-300"
                style={{
                  filter: 'blur(8px)',
                  transform: 'scale(1.05)',
                  opacity: fullLoaded ? 0 : 1,
                }}
              />
            )}
            {/* Preview fades in once loaded */}
            {(previewUrl || isGif) && (
              <img
                src={isGif ? fullUrl : previewUrl ?? ''}
                alt={file.filename}
                className="relative h-full w-full object-contain transition-opacity duration-300"
                style={{ opacity: (fullLoaded || isGif) ? 1 : 0 }}
                onLoad={() => !isGif && setFullLoaded(true)}
              />
            )}
          </>
        )}

        {isVideo && (
          <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">▶</div>
        )}
        {isGif && (
          <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">GIF</div>
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-800 bg-neutral-900 px-4 py-3">
        <p className="truncate text-sm font-medium text-white">{file.filename}</p>
        <p className="text-xs text-neutral-500">
          {Math.round(file.elo_score)} pts · {file.comparison_count} comparisons
        </p>
      </div>
    </div>
  )
}
