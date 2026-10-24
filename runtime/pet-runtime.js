/**
 * Shared pet runtime, injected by the native helper at document start.
 *
 * The pet HTML only registers visuals:
 *   DSHPet.register({ perform() { ...; return durationMs }, interrupt() { ... } })
 *
 * Drag, click-to-focus and the message bridge stay here so every pet behaves
 * the same and a pet never has to know about NSPanel or AppKit.
 */
(() => {
  let pet = null
  let dragging = false

  function send(type) {
    try {
      window.webkit?.messageHandlers?.pet?.postMessage({ type })
    } catch {}
  }

  window.DSHPet = {
    register(next) {
      pet = next
      // The helper sends the gaze, so it has to know when the pet is
      // ready to be pointed at something.
      send('ready')
    },
    perform() {
      try {
        return pet?.perform?.() ?? 0
      } catch (error) {
        console.error('dsh-pet: perform failed', error)
        return 0
      }
    },
    interrupt() {
      try {
        pet?.interrupt?.()
      } catch (error) {
        console.error('dsh-pet: interrupt failed', error)
      }
    },
    /**
     * The cursor is no longer over the pet.
     *
     * A WebView stops receiving pointer events as soon as the cursor leaves
     * it, so the page can never tell on its own that the gaze should end.
     * The native helper watches the mouse and calls this.
     */
    lookOut() {
      try {
        pet?.lookOut?.()
      } catch (error) {
        console.error('dsh-pet: lookOut failed', error)
      }
    },
    /**
     * Look at a point, in the page's own coordinates.
     *
     * The native helper sends this. A floating pet is not the frontmost
     * app, and macOS only hands mouse-moved events to the frontmost app,
     * so a page that waits for a pointer event never hears about the
     * cursor at all. The helper knows where the cursor is, so it says so.
     */
    look(x, y) {
      try {
        pet?.lookAt?.(x, y)
      } catch (error) {
        console.error('dsh-pet: look failed', error)
      }
    },
    /**
     * The pet was clicked.
     *
     * A pet answers a click with its reaction animation -- a jump, unless
     * the pet says otherwise. Pets that have no reaction of their own just
     * stop whatever they were doing.
     */
    react() {
      try {
        if (typeof pet?.react === 'function') pet.react()
        else pet?.interrupt?.()
      } catch (error) {
        console.error('dsh-pet: react failed', error)
      }
    },
  }

  document.documentElement.style.touchAction = 'none'

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return
    dragging = true
    // The pet answers the click with its reaction animation.
    window.DSHPet.react()
    try {
      document.documentElement.setPointerCapture(event.pointerId)
    } catch {}
    send('down')
    event.preventDefault()
  })

  document.addEventListener('pointermove', (event) => {
    if (!dragging) return
    // No message goes across the bridge here.
    //
    // The native helper reads the real cursor position itself and moves
    // the window on its own clock, so a message per pointer event would
    // only tell it something it already knows -- at the price of a trip
    // through the web view for every one of them.
    event.preventDefault()
  })

  function end(event) {
    if (!dragging) return
    dragging = false
    send('up')
    event.preventDefault()
  }

  document.addEventListener('pointerup', end)
  document.addEventListener('pointercancel', end)
  document.addEventListener('contextmenu', (event) => event.preventDefault())

  // Used by the native helper's --self-test to exercise the real pointer path.
  window.__petSelfTest = () => {
    const options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    document.body.dispatchEvent(new PointerEvent('pointerdown', options))
    document.body.dispatchEvent(new PointerEvent('pointerup', options))
  }
})()
