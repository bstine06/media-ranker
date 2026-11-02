import { useFolders } from '@renderer/contexts/FolderContext';
import { useTags } from '@renderer/contexts/TagsContext';
import { toMediaUrl } from '@renderer/lib/media';
import { useState, useEffect, useRef, useCallback } from 'react';

interface DbFile {
    id: number;
    path: string;
    media_type: 'video' | 'image';
}

interface Lane {
    currentFile: DbFile | null;
    nextFile: DbFile | null;
    isTransitioning: boolean;
}

const preloadCache = new Map<string, HTMLImageElement>();

function preloadImage(url: string): Promise<void> {
    if (preloadCache.has(url)) return Promise.resolve();
    const img = new Image();
    img.src = url;
    preloadCache.set(url, img);
    return img.decode().catch(() => {});
}

export default function TripleLaneSlideshow({
    onExit,
}: {
    onExit?: () => void;
}): JSX.Element {
    const [lanes, setLanes] = useState<[Lane, Lane, Lane]>([
        { currentFile: null, nextFile: null, isTransitioning: false },
        { currentFile: null, nextFile: null, isTransitioning: false },
        { currentFile: null, nextFile: null, isTransitioning: false },
    ]);
    const [showExitHint, setShowExitHint] = useState(false);

    const {activeTags, tagMode } = useTags();
    const {rootPath, folderPrefixes} = useFolders();

    const folderPrefixesRef = useRef(folderPrefixes);
    const activeTagsRef = useRef(activeTags);
    const tagModeRef = useRef(tagMode);
    const videoRefs = useRef<(HTMLVideoElement | null)[]>([null, null, null]);
    const mouseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        folderPrefixesRef.current = folderPrefixes;
    }, [folderPrefixes]);

    useEffect(() => {
        activeTagsRef.current = activeTags;
    }, [activeTags]);

    useEffect(() => {
        tagModeRef.current = tagMode;
    }, [tagMode]);

    const fetchRandomFile = useCallback(
        async (excludeIds: number[] = []): Promise<DbFile | null> => {
            const tags = activeTagsRef.current;
            const tagList = tags.size > 0 ? [...tags] : null;
            
            let file = await window.api.getRandomFile(
                folderPrefixesRef.current,
                tagList,
                tagModeRef.current,
                excludeIds,
            );

            if (!file) {
                file = await window.api.getRandomFile(
                    folderPrefixesRef.current,
                    tagList,
                    tagModeRef.current,
                    [],
                );
            }

            if (file && file.media_type !== 'video') {
                preloadImage(toMediaUrl(rootPath!, file.path));
            }

            return file;
        },
        [rootPath],
    );

    // Initialize all lanes
    useEffect(() => {
        const initLanes = async () => {
            const files = await Promise.all([
                fetchRandomFile(),
                fetchRandomFile(),
                fetchRandomFile(),
            ]);

            setLanes([
                { currentFile: files[0], nextFile: null, isTransitioning: false },
                { currentFile: files[1], nextFile: null, isTransitioning: false },
                { currentFile: files[2], nextFile: null, isTransitioning: false },
            ]);

            // Preload next files
            const nextFiles = await Promise.all([
                fetchRandomFile(files[0] ? [files[0].id] : []),
                fetchRandomFile(files[1] ? [files[1].id] : []),
                fetchRandomFile(files[2] ? [files[2].id] : []),
            ]);

            setLanes(prev => [
                { ...prev[0], nextFile: nextFiles[0] },
                { ...prev[1], nextFile: nextFiles[1] },
                { ...prev[2], nextFile: nextFiles[2] },
            ]);
        };

        initLanes();
    }, [fetchRandomFile]);

    const advanceLane = useCallback(
        async (laneIndex: number) => {
            setLanes(prev => {
                const newLanes = [...prev] as [Lane, Lane, Lane];
                newLanes[laneIndex] = {
                    ...newLanes[laneIndex],
                    isTransitioning: true,
                };
                return newLanes;
            });

            // Wait for transition
            await new Promise(resolve => setTimeout(resolve, 600));

            setLanes(prev => {
                const newLanes = [...prev] as [Lane, Lane, Lane];
                const currentIds = prev.map(l => l.currentFile?.id).filter(Boolean) as number[];
                
                newLanes[laneIndex] = {
                    currentFile: prev[laneIndex].nextFile,
                    nextFile: null,
                    isTransitioning: false,
                };

                // Fetch next file in background
                fetchRandomFile(currentIds).then(nextFile => {
                    setLanes(current => {
                        const updated = [...current] as [Lane, Lane, Lane];
                        updated[laneIndex] = {
                            ...updated[laneIndex],
                            nextFile,
                        };
                        return updated;
                    });
                });

                return newLanes;
            });
        },
        [fetchRandomFile],
    );

    // Handle video ended
    const handleVideoEnded = useCallback(
        (laneIndex: number) => {
            advanceLane(laneIndex);
        },
        [advanceLane],
    );

    // Handle image display duration (5 seconds)
    useEffect(() => {
        const timers: NodeJS.Timeout[] = [];

        lanes.forEach((lane, index) => {
            if (lane.currentFile && lane.currentFile.media_type === 'image' && !lane.isTransitioning) {
                const timer = setTimeout(() => {
                    advanceLane(index);
                }, 5000);
                timers.push(timer);
            }
        });

        return () => {
            timers.forEach(timer => clearTimeout(timer));
        };
    }, [lanes, advanceLane]);

    // Handle escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && onExit) {
                onExit();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onExit]);

    // Show exit hint on mouse movement
    const handleMouseMove = useCallback(() => {
        setShowExitHint(true);
        
        if (mouseTimeoutRef.current) {
            clearTimeout(mouseTimeoutRef.current);
        }

        mouseTimeoutRef.current = setTimeout(() => {
            setShowExitHint(false);
        }, 2000);
    }, []);

    useEffect(() => {
        return () => {
            if (mouseTimeoutRef.current) {
                clearTimeout(mouseTimeoutRef.current);
            }
        };
    }, []);

    return (
        <div className="triple-lane-container" onMouseMove={handleMouseMove}>
            {lanes.map((lane, index) => (
                <div key={index} className="lane">
                    <div className={`media-wrapper ${lane.isTransitioning ? 'fade-out' : 'fade-in'}`}>
                        {lane.currentFile && (
                            lane.currentFile.media_type === 'video' ? (
                                <video
                                    ref={el => videoRefs.current[index] = el}
                                    src={toMediaUrl(rootPath!, lane.currentFile.path)}
                                    autoPlay
                                    playsInline
                                    onEnded={() => handleVideoEnded(index)}
                                    className="media-content"
                                />
                            ) : (
                                <img
                                    src={toMediaUrl(rootPath!, lane.currentFile.path)}
                                    alt=""
                                    className="media-content"
                                />
                            )
                        )}
                    </div>
                </div>
            ))}

            {onExit && (
                <button 
                    className={`exit-button ${showExitHint ? 'visible' : ''}`}
                    onClick={onExit}
                    aria-label="Exit slideshow"
                >
                    ×
                </button>
            )}

            <style>{`
                .triple-lane-container {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    display: flex;
                    background: #000;
                    overflow: hidden;
                    margin: 0;
                    padding: 0;
                }

                .lane {
                    flex: 1;
                    position: relative;
                    overflow: hidden;
                    border-right: 1px solid rgba(255, 255, 255, 0.05);
                }

                .lane:last-child {
                    border-right: none;
                }

                .media-wrapper {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    transition: opacity 0s ease-in-out;
                }

                .media-wrapper.fade-in {
                    opacity: 1;
                }

                .media-wrapper.fade-out {
                    opacity: 0;
                }

                .media-content {
                    width: 100%;
                    height: 100%;
                    object-fit: contain;
                    display: block;
                }

                .exit-button {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    width: 44px;
                    height: 44px;
                    border: none;
                    background: rgba(0, 0, 0, 0.6);
                    color: rgba(255, 255, 255, 0.8);
                    font-size: 32px;
                    line-height: 1;
                    cursor: pointer;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    transition: opacity 0.3s ease, background 0.2s ease, transform 0.2s ease;
                    pointer-events: none;
                    z-index: 1000;
                    backdrop-filter: blur(8px);
                }

                .exit-button.visible {
                    opacity: 1;
                    pointer-events: auto;
                }

                .exit-button:hover {
                    background: rgba(0, 0, 0, 0.8);
                    color: #fff;
                    transform: scale(1.05);
                }

                .exit-button:active {
                    transform: scale(0.95);
                }

                /* Remove any default margins/padding */
                body {
                    margin: 0;
                    padding: 0;
                    overflow: hidden;
                }
            `}</style>
        </div>
    );
}