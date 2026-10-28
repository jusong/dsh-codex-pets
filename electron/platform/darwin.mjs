/**
 * macOS: the pet is a non-activating panel.
 *
 * Pressing it makes the panel key without activating this app, so the user's
 * own app stays in front and keeps typing. The drag is a native drag region,
 * carried by the window server.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const DSH_BUNDLE_ID = 'com.deepseek.dsh'

export default {
  name: 'darwin',
  /** Extra BrowserWindow options for the pet and the question card. */
  windowOptions: { type: 'panel', focusable: true },
  /** The pet is dragged by the OS (a drag region), and a click is read from focus. */
  nativeDrag: true,

  /** Once, before any window. */
  prepare(app) {
    app.dock?.hide()
  },

  /** Float above other windows, on every Space and over full-screen apps. */
  float(win, app) {
    win.setAlwaysOnTop(true, 'floating')
    // Without skipTransformProcessType the app briefly turns into a regular
    // one and the Dock icon comes back.
    win.setVisibleOnAllWorkspaces(true, { visibleInFullScreen: true, skipTransformProcessType: true })
    app.dock?.hide()
  },

  /** Bring DSH forward; start it if it is not running. */
  activateHost({ hostApp }) {
    const args = hostApp && existsSync(hostApp) ? [hostApp] : ['-b', DSH_BUNDLE_ID]
    execFile('/usr/bin/open', args, () => {})
  },
}
