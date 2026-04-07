import { getDb } from './db'
import type { DbFile } from './db'

const K_LOW = 32   // fewer than 10 comparisons
const K_MID = 16   // 10–30 comparisons
const K_HIGH = 8   // 30+ comparisons

function kFactor(comparisonCount: number): number {
  if (comparisonCount < 10) return K_LOW
  if (comparisonCount < 30) return K_MID
  return K_HIGH
}

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400))
}

// Maps a 1–3 point differential to an Elo "actual score" for the winner.
function marginToScore(margin: number): number {
  const clipped = Math.max(1, Math.min(3, Math.round(margin)))
  const scores: Record<number, number> = { 1: 0.9, 2: 1.1, 3: 1.3 }
  return scores[clipped]
}

export function computeEloUpdate(
  winner: DbFile,
  loser: DbFile,
  margin: number = 1
): { newWinnerScore: number; newLoserScore: number } {
  const expectedWinner = expectedScore(winner.elo_score, loser.elo_score)
  const expectedLoser = expectedScore(loser.elo_score, winner.elo_score)

  const kWinner = kFactor(winner.comparison_count)
  const kLoser = kFactor(loser.comparison_count)

  const multiplier = marginToScore(margin)

  const newWinnerScore = winner.elo_score + kWinner * multiplier * (1 - expectedWinner)
  const newLoserScore = loser.elo_score + kLoser * multiplier * (0 - expectedLoser)

  return { newWinnerScore, newLoserScore }
}

export function getWeightedPair(
  folderPrefixes: string[] | null,
  tagList: string[] | null,
  tagMode: "and" | "or" = "or"
): [DbFile, DbFile] | null {
  const db = getDb()

  const conditions: string[] = []
  const params: unknown[] = []

  if (folderPrefixes && folderPrefixes.length > 0) {
    const folderConds = folderPrefixes.map(() => "f.path LIKE ?").join(" OR ")
    conditions.push(`(${folderConds})`)
    params.push(...folderPrefixes.map(p => `${p}%`))
  }

  if (tagList && tagList.length > 0) {
    if (tagMode === "or") {
    const placeholders = tagList.map(() => "?").join(", ")
    conditions.push(`
        f.id IN (
            SELECT file_id FROM tags
            WHERE tag IN (${placeholders})
        )
    `)
    params.push(...tagList)
} else {
    tagList.forEach(tag => {
        conditions.push(`
            f.id IN (
                SELECT file_id FROM tags
                WHERE tag = ?
            )
        `)
        params.push(tag)
    })
}
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : ""

  // Alias the table so tag subqueries can reference it unambiguously
  const allFiles = db
    .prepare(`SELECT f.* FROM files f ${whereClause}`)
    .all(...params) as DbFile[]

  if (allFiles.length < 2) return null

  // --- rest of your weighted selection logic is unchanged ---
  const roll = Math.random()
  let fileA: DbFile

  if (roll < 0.3) {
    const sorted = [...allFiles].sort((a, b) => a.comparison_count - b.comparison_count)
    const pool = sorted.slice(0, Math.max(2, Math.floor(sorted.length * 0.3)))
    fileA = pool[Math.floor(Math.random() * pool.length)]
  } else {
    fileA = allFiles[Math.floor(Math.random() * allFiles.length)]
  }

  let fileB: DbFile

  if (roll >= 0.1 && roll < 0.9) {
    const others = allFiles.filter(f => f.id !== fileA.id)
    const sorted = [...others].sort(
      (a, b) =>
        Math.abs(a.elo_score - fileA.elo_score) -
        Math.abs(b.elo_score - fileA.elo_score)
    )
    const pool = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2)))
    fileB = pool[Math.floor(Math.random() * pool.length)]
  } else {
    const others = allFiles.filter(f => f.id !== fileA.id)
    fileB = others[Math.floor(Math.random() * others.length)]
  }

  return [fileA, fileB]
}