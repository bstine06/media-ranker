export function toMediaUrl(rootPath: string, relativePath: string): string {
  const absolute = `${rootPath}/${relativePath}`
  return `media://local${absolute}`
}

export function toThumbnailUrl(absPath: string): string {
  return `media://local${absPath}`
}