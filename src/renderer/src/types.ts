export interface DbFile {
  id: number
  content_hash: string
  path: string
  filename: string
  media_type: 'photo' | 'gif' | 'video'
  elo_score: number
  comparison_count: number
  date_indexed: string
}

export interface FolderNode {
  name: string
  relativePath: string
  children: FolderNode[]
}