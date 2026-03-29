import { useEffect, useState, useCallback } from 'react'
import type { DbFile } from './types'
import NavItem from './components/NavItem'
import BrowseView from './components/BrowseView'

type View = 'browse' | 'compare' | 'rankings'

function WelcomeScreen({
  onSelect,
  isLoading,
}: {
  onSelect: () => void
  isLoading: boolean
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-neutral-950">
      <div className="titlebar-drag absolute inset-x-0 top-0 h-10" />
      <h1 className="text-3xl font-bold text-white">Media Ranker</h1>
      <p className="text-neutral-400">Choose a folder to begin.</p>
      <button
        onClick={onSelect}
        disabled={isLoading}
        className="rounded-lg bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-50"
      >
        {isLoading ? 'Scanning…' : 'Open Library Folder'}
      </button>
    </div>
  )
}

function PlaceholderView({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
      {label}
    </div>
  )
}

export default function App(): JSX.Element {
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [view, setView] = useState<View>('browse')
  const [subfolders, setSubfolders] = useState<string[]>([])
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [files, setFiles] = useState<DbFile[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [scanResult, setScanResult] = useState<{ scanned: number; added: number } | null>(null)

  const loadFolder = useCallback(async (folder: string | null, root: string) => {
    setActiveFolder(folder)
    const result = folder
      ? await window.api.getFilesInFolder(folder)
      : await window.api.getAllFiles()
    setFiles(result)
  }, [])

  const openLibrary = useCallback(async (path: string) => {
    setIsScanning(true)
    setRootPath(path)
    const result = await window.api.openLibrary(path)
    setScanResult({ scanned: result.scanned, added: result.added })
    const folders = await window.api.getSubfolders()
    setSubfolders(folders)
    await loadFolder(null, path)
    setIsScanning(false)
  }, [loadFolder])

  const handleSelectFolder = async () => {
    const path = await window.api.selectRootFolder()
    if (path) await openLibrary(path)
  }

  useEffect(() => {
    window.api.getRootPath().then((savedPath) => {
      if (savedPath) openLibrary(savedPath)
    })
  }, [])

  if (!rootPath) {
    return <WelcomeScreen onSelect={handleSelectFolder} isLoading={isScanning} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="titlebar-drag flex h-10 shrink-0 items-center bg-neutral-900 px-4 pl-20">
        <span className="titlebar-no-drag text-sm font-medium text-neutral-400">
          Media Ranker
        </span>
        {scanResult && (
          <span className="titlebar-no-drag ml-3 text-xs text-neutral-600">
            {scanResult.scanned} files · {scanResult.added} new
          </span>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-52 shrink-0 flex-col gap-1 border-r border-neutral-800 bg-neutral-900 p-3">
          <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Views
          </p>
          <NavItem label="Browse" active={view === 'browse'} onClick={() => setView('browse')} />
          <NavItem label="Compare" active={view === 'compare'} onClick={() => setView('compare')} />
          <NavItem label="Rankings" active={view === 'rankings'} onClick={() => setView('rankings')} />

          {subfolders.length > 0 && (
            <>
              <p className="mb-1 mt-4 px-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
                Folders
              </p>
              <NavItem
                label="All"
                active={view === 'browse' && activeFolder === null}
                onClick={() => { setView('browse'); loadFolder(null, rootPath) }}
              />
              {subfolders.map((folder) => (
                <NavItem
                  key={folder}
                  label={folder}
                  active={view === 'browse' && activeFolder === folder}
                  onClick={() => { setView('browse'); loadFolder(folder, rootPath) }}
                />
              ))}
            </>
          )}

          <div className="mt-auto">
            <button
              onClick={handleSelectFolder}
              className="w-full rounded-md px-3 py-2 text-left text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              ⌂ Change library
            </button>
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden bg-neutral-950 min-w-0">
          {view === 'browse' && (
            <BrowseView files={files} rootPath={rootPath} activeFolder={activeFolder} />
          )}
          {view === 'compare' && (
            <PlaceholderView label="Compare mode coming in layer 4" />
          )}
          {view === 'rankings' && (
            <PlaceholderView label="Rankings view coming in layer 4" />
          )}
        </main>
      </div>
    </div>
  )
}