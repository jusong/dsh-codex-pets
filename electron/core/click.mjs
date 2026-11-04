/**
 * Click or drag? The pet is a native drag region, which is what keeps the
 * drag smooth: macOS moves the window and no script is involved. The price
 * is that a press on it reaches nobody, so a click is read off what the
 * window does around it:
 *
 * - the press makes the (non-activating) panel key, so `focus` fires;
 * - a press that turns into a drag carries the cursor away with it, so by the
 *   time the press has settled the cursor is no longer where it pressed;
 * - a press that the page did see (the session ball, a right click) is not
 *   a click on the pet.
 *
 * So: a focus on the pet whose cursor stayed put, with no page-visible press
 * nearby, is a click. The cursor is what settles it, not the window: the
 * window moves on its own when the strip is relaid out, and that must never
 * cost the user a click. So both "is this the pet?" and "did it move?" are
 * asked of the cursor -- the first when the press lands, the second when it
 * settles -- and never of where the window happens to be. A shaky hand wanders
 * a point or two and still counts as a click: the same three points the native
 * helper used before this window was Electron.
 */
export function createClickDecider({
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  /** Where the cursor is now, in screen points. */
  cursor = () => null,
  /** How long after `focus` to let the press settle. */
  settle = 160,
  /** How far the cursor may wander and still be a click. */
  slop = 3,
  /** How far around `focus` a press the page saw still explains it. */
  shield = 250,
  /**
   * False when this press has nothing to do with the pet (the cursor is
   * elsewhere, the question card just closed...). Asked once, when the press
   * lands: the window may move while the press settles, and a window that
   * moved must not turn a click into an ignored press.
   */
  guard = () => true,
  onDecision,
} = {}) {
  let lastPress = -Infinity
  let timer = null

  return {
    /** The page saw a mouse press (any button). */
    pagePress() {
      lastPress = now()
    },
    /** The window became key. */
    focus() {
      const at = now()
      const from = cursor()
      const onPet = guard()
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        timer = null
        const decided = now()
        const to = cursor()
        const travelled = from === null || to === null ? 0 : Math.hypot(to.x - from.x, to.y - from.y)
        let kind = 'click'
        if (!onPet) kind = 'ignored'
        else if (travelled > slop) kind = 'drag'
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
