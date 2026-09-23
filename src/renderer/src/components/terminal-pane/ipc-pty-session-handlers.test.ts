import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { ptyReplayHandlers } from './pty-shutdown-data-suspension'
import { createPtyOutputProcessor } from './pty-output-processor'
import type { PtyTransport } from './pty-transport-types'
import type { SshReattachModelSnapshot } from '../../../../shared/terminal-mode-reset-profiles'

type PtyCallbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

const PTY_ID = 'test-replay-routing'

const SNAPSHOT: SshReattachModelSnapshot = {
  data: 'frame',
  scrollbackAnsi: 'history',
  cols: 80,
  rows: 24,
  alternateScreen: false
}

function setup(callbacks: PtyCallbacks, currentId: string | null = PTY_ID) {
  const handlers = createIpcPtySessionHandlers({
    outputProcessor: createPtyOutputProcessor({}),
    getPtyId: () => currentId,
    getCallbacks: () => callbacks,
    getSuppressAttentionEvents: () => false,
    markExited: () => {}
  })
  handlers.registerData(PTY_ID)
  return handlers
}

describe('ipc pty session replay routing', () => {
  afterEach(() => {
    ptyReplayHandlers.delete(PTY_ID)
  })

  it('paints a model snapshot through the snapshot path, not the verbatim drain', () => {
    const onModelSnapshotReplay = vi.fn()
    const onReplayData = vi.fn()
    setup({ onModelSnapshotReplay, onReplayData })
    ptyReplayHandlers.get(PTY_ID)?.('fallback', SNAPSHOT)
    expect(onModelSnapshotReplay).toHaveBeenCalledWith(SNAPSHOT)
    expect(onReplayData).not.toHaveBeenCalled()
  })

  it('sends plain replays to the verbatim drain when no snapshot is present', () => {
    const onModelSnapshotReplay = vi.fn()
    const onReplayData = vi.fn()
    setup({ onModelSnapshotReplay, onReplayData })
    ptyReplayHandlers.get(PTY_ID)?.('raw-bytes')
    expect(onReplayData).toHaveBeenCalledWith('raw-bytes')
    expect(onModelSnapshotReplay).not.toHaveBeenCalled()
  })

  it('falls back to live data when the pane has no replay path', () => {
    const onData = vi.fn()
    setup({ onData })
    ptyReplayHandlers.get(PTY_ID)?.('raw-bytes')
    expect(onData).toHaveBeenCalledWith('raw-bytes')
  })

  it('ignores replays for a pty id the pane no longer owns', () => {
    const onModelSnapshotReplay = vi.fn()
    const onReplayData = vi.fn()
    setup({ onModelSnapshotReplay, onReplayData }, 'other-pty')
    ptyReplayHandlers.get(PTY_ID)?.('fallback', SNAPSHOT)
    ptyReplayHandlers.get(PTY_ID)?.('raw-bytes')
    expect(onModelSnapshotReplay).not.toHaveBeenCalled()
    expect(onReplayData).not.toHaveBeenCalled()
  })
})
