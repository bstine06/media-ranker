export {}

declare global {
  interface Window {
    api: {
      ping: () => Promise<string>
      selectRootFolder: () => Promise<string | null>
      openLibrary: (folderPath: string) => Promise<{ scanned: number; added: number; updated: number; unsupported: number }>
      getRootPath: () => Promise<string | null>
      getSubfolders: () => Promise<string[]>
      getAllFiles: () => Promise<import('./types').DbFile[]>
      getFilesInFolder: (folderRelPath: string) => Promise<import('./types').DbFile[]>
      getThumbnailPath: (hash: string) => Promise<string | null>
      getTags: (fileId: number) => Promise<string[]>
      addTag: (fileId: number, tag: string) => Promise<string[]>
      removeTag: (fileId: number, tag: string) => Promise<string[]>
    }
  }
}