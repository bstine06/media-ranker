export function toMediaUrl(rootPath: string, relativePath: string): string {
  const absolute = `${rootPath}/${relativePath}`
  return `media://local${absolute}`
}

export function toThumbnailUrl(absPath: string): string {
  return `media://local${absPath}`
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}