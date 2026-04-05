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
// margin 1 → 0.6, margin 2 → 0.75, margin 3 → 1.0
function marginToScore(margin: number): number {
  const clipped = Math.max(1, Math.min(3, Math.round(margin)))
  const scores: Record<number, number> = { 1: 0.6, 2: 0.75, 3: 1.0 }
  return scores[clipped]
}

export function computeEloUpdate(
  winner: DbFile,
  loser: DbFile,
  margin: number = 1 // point differential, 1–3
): { newWinnerScore: number; newLoserScore: number } {
  const expectedWinner = expectedScore(winner.elo_score, loser.elo_score)
  const expectedLoser = expectedScore(loser.elo_score, winner.elo_score)

  const kWinner = kFactor(winner.comparison_count)
  const kLoser = kFactor(loser.comparison_count)

  const actualWinner = marginToScore(margin)
  const actualLoser = 1 - actualWinner  // mirror: 0.4, 0.25, or 0.0

  const newWinnerScore = winner.elo_score + kWinner * (actualWinner - expectedWinner)
  const newLoserScore = loser.elo_score + kLoser * (actualLoser - expectedLoser)

  return { newWinnerScore, newLoserScore }
}

export function getWeightedPair(folderPrefixes: string[] | null): [DbFile, DbFile] | null {
  const db = getDb()

  // Build the WHERE clause based on folder filter
  let whereClause = ''
  if (folderPrefixes && folderPrefixes.length > 0) {
    const conditions = folderPrefixes.map(() => "path LIKE ?").join(' OR ')
    whereClause = `WHERE (${conditions})`
  }

  const allFiles = db
    .prepare(`SELECT * FROM files ${whereClause}`)
    .all(...(folderPrefixes?.map(p => `${p}%`) ?? [])) as DbFile[]

  if (allFiles.length < 2) return null

  // Pick file A using weighted strategy
  const roll = Math.random()
  let fileA: DbFile

  if (roll < 0.3) {
    // 30%: prioritize files with low comparison count
    const sorted = [...allFiles].sort((a, b) => a.comparison_count - b.comparison_count)
    const pool = sorted.slice(0, Math.max(2, Math.floor(sorted.length * 0.3)))
    fileA = pool[Math.floor(Math.random() * pool.length)]
  } else if (roll < 0.9) {
    // 60%: pick randomly, then find a close Elo opponent
    fileA = allFiles[Math.floor(Math.random() * allFiles.length)]
  } else {
    // 10%: fully random
    fileA = allFiles[Math.floor(Math.random() * allFiles.length)]
  }

  // Pick file B
  let fileB: DbFile

  if (roll >= 0.1 && roll < 0.9) {
    // Find closest Elo opponent to fileA (excluding fileA itself)
    const others = allFiles.filter(f => f.id !== fileA.id)
    const sorted = [...others].sort(
      (a, b) =>
        Math.abs(a.elo_score - fileA.elo_score) -
        Math.abs(b.elo_score - fileA.elo_score)
    )
    // Pick from the top 20% closest
    const pool = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2)))
    fileB = pool[Math.floor(Math.random() * pool.length)]
  } else {
    // Random opponent
    const others = allFiles.filter(f => f.id !== fileA.id)
    fileB = others[Math.floor(Math.random() * others.length)]
  }

  return [fileA, fileB]
}