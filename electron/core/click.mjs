/**
 * Click or drag? The pet is a native drag region, which is what keeps the
 * drag smooth: macOS moves the window and no script is involved. The price
 * is that a press on it reaches nobody, so a click is read off what the
 * window does around it:
 *
 * - the press makes the (non-activating) panel key, so `focus` fires;
 * - a drag also fires `will-move`, within a few dozen milliseconds, on either
 *   side of `focus`;
 * - a press that the page did see (the session ball, a right click) is not
 *   a click on the pet.
 *
 * So: a focus with no will-move nearby and no page-visible press nearby is a
 * click on the pet.
 */
export function createClickDecider({
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  /** How long after `focus` to wait for a will-move. */
  settle = 160,
  /** How far before `focus` a will-move may have come. */
  lead = 300,
  /** How far around `focus` a press the page saw still explains it. */
  shield = 250,
  /** False when this focus has nothing to do with the pet (the cursor is elsewhere, the question card just closed...). */
  guard = () => true,
  onDecision,
} = {}) {
  let lastMove = -Infinity
  let lastPress = -Infinity
  let timer = null

  return {
    /** The window is being dragged. */
    willMove() {
      lastMove = now()
    },
    /** The page saw a mouse press (any button). */
    pagePress() {
      lastPress = now()
    },
    /** The window became key. */
    focus() {
      const at = now()
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        timer = null
        const decided = now()
        let kind = 'click'
        if (!guard()) kind = 'ignored'
        else if (lastMove >= at - lead && lastMove <= decided) kind = 'drag'
        else if (lastPress >= at - shield && lastPress <= decided) kind = 'ignored'
        onDecision?.(kind)
      }, settle)
    },
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
