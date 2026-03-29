import { useRef, useState, useCallback } from 'react'

export interface PreviewState {
  anchorY: number
  tileRight: number
  tileLeft: number
  naturalW: number | null
  naturalH: number | null
}

export interface PreviewLayout {
  x: number
  y: number
  width: number
  height: number
}

function computeLayout(state: PreviewState): PreviewLayout {
  const maxW = window.innerWidth * 0.75
  const maxH = window.innerHeight * 0.75

  const natW = state.naturalW ?? 1600
  const natH = state.naturalH ?? 900

  const scale = Math.min(maxW / natW, maxH / natH)
  const width = natW * scale
  const height = natH * scale

  const spaceRight = window.innerWidth - state.tileRight
  const x = spaceRight > width + 16
    ? state.tileRight + 8
    : state.tileLeft - width - 8

  const y = Math.min(state.anchorY, window.innerHeight - height - 16)

  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, y),
    width,
    height,
  }
}

export function useHoverPreview(delayMs = 200) {
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const previewRef = useRef<PreviewState | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elementRef = useRef<HTMLElement | null>(null)

  const handleMouseEnter = useCallback(() => {
    const rect = elementRef.current?.getBoundingClientRect()
    if (!rect) return
    hoverTimer.current = setTimeout(() => {
      const state: PreviewState = {
        anchorY: rect.top,
        tileRight: rect.right,
        tileLeft: rect.left,
        naturalW: null,
        naturalH: null,
      }
      previewRef.current = state
      setPreview(state)
    }, delayMs)
  }, [delayMs])

  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    previewRef.current = null
    setPreview(null)
  }, [])

  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (!previewRef.current) return
    const updated = { ...previewRef.current, naturalW: w, naturalH: h }
    previewRef.current = updated
    setPreview(updated)
  }, [])

  const layout = preview ? computeLayout(preview) : null

  return {
    elementRef,
    preview,
    layout,
    handleMouseEnter,
    handleMouseLeave,
    handleNaturalSize,
  }
}