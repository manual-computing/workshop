import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const {
  acceptOutputDataMock,
  muxRequestMock,
  openConsumerSessionMock,
  attachForReconnectMock,
  ptyDataHandlerRef
} = vi.hoisted(() => ({
  acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn(),
  attachForReconnectMock: vi.fn().mockResolvedValue({}),
  ptyDataHandlerRef: { current: undefined as undefined | ((payload: unknown) => void) }
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: acceptOutputDataMock,
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  allocateSshPtyProviderGeneration: vi.fn(() => 23),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  installSshPtySourceAckPublisher: vi.fn(),
  installSshPtySourceCancellationPublisher: vi.fn(),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true)
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: vi.fn().mockReturnValue(false),
  isSshPtyIdentityMismatchError: vi.fn().mockReturnValue(false),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockImplementation((handler) => {
      ptyDataHandlerRef.current = handler
      return () => {}
    })
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attachForReconnect = attachForReconnectMock
    setPtyDeliveryPauseAdapter = vi.fn()
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  isCurrentPtyExit: vi.fn(() => true),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  setPtyOwnership: vi.fn()
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { getPtyIdsForConnection, getSshPtyProvider, registerSshPtyProvider } =
  await import('../ipc/pty')
const { getSshPtyAcceptedSourceCheckpoints } = await import('../ipc/ssh-pty-output-intake-registry')
const { applySshPtySourceCancellationProof } = await import('../ipc/ssh-pty-output-intake-registry')
const { applySshPtySourceRecoveryCancellationProof } =
  await import('../ipc/ssh-pty-output-intake-registry')

describe('SshRelaySession expired-checkpoint replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ptyDataHandlerRef.current = undefined
    attachForReconnectMock.mockResolvedValue({})
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([])
    vi.mocked(applySshPtySourceCancellationProof).mockReturnValue(true)
    vi.mocked(applySshPtySourceRecoveryCancellationProof).mockReturnValue(true)
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  async function prepareRecovery(targetId: string): Promise<{
    session: SshRelaySession
    deps: ReturnType<typeof createMockDeps>
  }> {
    let generation = 0
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      state: {
        mode: 'negotiated',
        clientInstanceId: options.clientInstanceId,
        clientGeneration: ++generation,
        ownerGeneration: generation,
        ownerLease: `owner-lease-${generation}`,
        outputFlowControl: { version: 1, windowSu: 256 * 1024 }
      },
      resumed: options.resume !== undefined
    }))
    const deps = createMockDeps()
    const session = new SshRelaySession(
      targetId,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([`ssh:${targetId}@@pty-1`])
    vi.mocked(getSshPtyProvider).mockImplementation(
      () => vi.mocked(registerSshPtyProvider).mock.calls.at(-1)?.[1]
    )
    return { session, deps }
  }

  it('replays the missed tail before draining attach-window bytes', async () => {
    const targetId = 'expired-replay-before-drain'
    const { session, deps } = await prepareRecovery(targetId)
    const appPtyId = `ssh:${targetId}@@pty-1`
    let attachCalls = 0
    attachForReconnectMock.mockImplementation(async () => {
      attachCalls += 1
      if (attachCalls === 1) {
        return {
          sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' },
          sourceActivationLease: { commit: vi.fn(), rollback: async () => true }
        }
      }
      // Attach-window frame: emitted while the retry attach is in flight, so it
      // quarantines into queuedData instead of flowing live.
      ptyDataHandlerRef.current?.({
        id: appPtyId,
        data: 'newer-attach-window',
        providerGeneration: 23,
        ptyIncarnation: 'incarnation-1',
        sequenceChars: 19,
        source: {
          relayPtyId: 'pty-1',
          spanId: 'new-token:0:19',
          clientGeneration: 2,
          ownerGeneration: 2,
          deliveryToken: 'new-token',
          sourceStartSu: 0,
          sourceEndSu: 19
        }
      })
      return {
        sourceActivation: { clientGeneration: 2, ownerGeneration: 2 },
        sourceActivationLease: { commit: vi.fn(), rollback: async () => true },
        replay: 'old-tail'
      }
    })
    let queuedAtReplay: number | undefined
    let passthroughAtReplay: boolean | undefined
    const sessionAny = session as unknown as {
      forwardReattachReplay: (...args: never[]) => Promise<void>
      acceptPtyData: (...args: never[]) => Promise<void>
      pendingPtyReattaches: Map<string, { queuedData: unknown[]; livePassthrough: boolean }>
    }
    const originalReplay = sessionAny.forwardReattachReplay.bind(session)
    const replaySpy = vi
      .spyOn(sessionAny, 'forwardReattachReplay')
      .mockImplementation(async (...args: never[]) => {
        const pending = sessionAny.pendingPtyReattaches.get(appPtyId)
        queuedAtReplay = pending?.queuedData.length
        passthroughAtReplay = pending?.livePassthrough
        return originalReplay(...args)
      })
    const acceptSpy = vi.spyOn(sessionAny, 'acceptPtyData')
    await session.reconnect(deps.mockConn)
    // The clearing replay must observe the still-queued newer bytes: replay(old)
    // runs before drain(newer), and passthrough flips only after the drain.
    expect(replaySpy).toHaveBeenCalledOnce()
    expect(queuedAtReplay).toBe(1)
    expect(passthroughAtReplay).toBe(false)
    expect(acceptSpy).toHaveBeenCalledOnce()
    expect(replaySpy.mock.invocationCallOrder[0]).toBeLessThan(
      acceptSpy.mock.invocationCallOrder[0]!
    )
    expect(acceptOutputDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'newer-attach-window' })
    )
    expect(deps.mockWindow.webContents.send).toHaveBeenCalledWith(
      'pty:replay',
      expect.objectContaining({ id: appPtyId, data: 'old-tail' })
    )
  })
})
