import type { DbFile } from '../types'
import MediaTile from './MediaTile'

export default function BrowseView({
  files,
  rootPath,
  activeFolder,
}: {
  files: DbFile[]
  rootPath: string
  activeFolder: string | null
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
        <h2 className="text-sm font-medium text-neutral-300">
          {activeFolder ?? 'All Files'}
        </h2>
        <span className="text-xs text-neutral-600">{files.length} files</span>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-neutral-600 text-sm">
          No media found in this folder.
        </div>
      ) : (
        <div
          className="grid-media overflow-y-auto overflow-x-hidden p-4"
          style={{ scrollbarGutter: 'stable' }}
        >
          {files.map((file) => (
            <MediaTile key={file.id} file={file} rootPath={rootPath} />
          ))}
        </div>
      )}
    </div>
  )
}