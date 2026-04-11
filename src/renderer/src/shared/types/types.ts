export interface DbFile {
  id: number
  content_hash: string
  path: string
  filename: string
  media_type: 'photo' | 'gif' | 'video'
  elo_score: number
  comparison_count: number
  date_indexed: string
  mtime: number        // was this intentionally omitted before?
  size: number         // same
  status: 'active' | 'missing'
  missing_since: string | null  // optional — only if you surface it in UI
}

export interface FolderNode {
  name: string
  relativePath: string
  children: FolderNode[]
}