/**
 * Where the pet and the window go. Screen coordinates here have their origin
 * at the top left (Electron's), and a rectangle is `{ x, y, width, height }`.
 */

export const MAX_EDGE = 260
export const MIN_EDGE = 80
export const BADGE = 36
export const LIST_WIDTH = 300
export const ROW_HEIGHT = 48

export const clampEdge = (value) => Math.min(MAX_EDGE, Math.max(MIN_EDGE, Math.round(value)))

/** How tall the strip under the pet is. Zero when there is nothing to list. */
export function chromeHeight({ chromeOn, count, expanded }) {
  if (!chromeOn || count <= 0) return 0
  const topGap = 6
  const bottom = 10
  if (!expanded) return topGap + BADGE + bottom
  return topGap + BADGE + 8 + ROW_HEIGHT * count + bottom
}

/** The window for a pet of `edge`, with the strip under it when there is one. */
export function windowSize(edge, chrome) {
  if (chrome === 0) return { width: edge, height: edge }
  return { width: Math.max(edge, LIST_WIDTH + 16), height: edge + chrome }
}

/** Where the pet is drawn inside a window: centred without a strip, pinned to the top with one. */
export function petSlot(width, height, edge, chrome) {
  if (chrome === 0) return { x: width / 2 - edge / 2, y: height / 2 - edge / 2, width: edge, height: edge }
  return { x: width / 2 - edge / 2, y: 0, width: edge, height: edge }
}

/** The pet's rectangle on screen, from the window's. */
export function petOnScreen(bounds, edge, chrome) {
  const slot = petSlot(bounds.width, bounds.height, edge, chrome)
  return { x: bounds.x + slot.x, y: bounds.y + slot.y, width: slot.width, height: slot.height }
}

const within = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))

/**
 * Bounds for a window of `size` that keeps the pet's centre where it is.
 * `drawnEdge` is how big the pet is drawn, `chrome` the strip's height.
 */
export function placeWindow({ center, size, drawnEdge, chrome, visible }) {
  const slot = petSlot(size.width, size.height, drawnEdge, chrome)
  let x = center.x - (slot.x + slot.width / 2)
  let y = center.y - (slot.y + slot.height / 2)
  if (visible) {
    x = within(x, visible.x, visible.x + visible.width - size.width)
    y = within(y, visible.y, visible.y + visible.height - size.height)
  }
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height }
}

/** The question card: 12px off the pet, on the other side when it would leave the screen. */
export function askDialogOrigin(pet, dialog, visible, gap = 12) {
  let x = pet.x + pet.width + gap
  let y = pet.y + pet.height / 2 - dialog.height / 2
  if (x + dialog.width > visible.x + visible.width) x = pet.x - dialog.width - gap
  x = within(x, visible.x, visible.x + visible.width - dialog.width)
  y = within(y, visible.y, visible.y + visible.height - dialog.height)
  return { x: Math.round(x), y: Math.round(y) }
}

/** Does any display's work area meet this rectangle? */
export function onSomeScreen(rect, areas) {
  return areas.some((a) => rect.x < a.x + a.width && rect.x + rect.width > a.x && rect.y < a.y + a.height && rect.y + rect.height > a.y)
}
