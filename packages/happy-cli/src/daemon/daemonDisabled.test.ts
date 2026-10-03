import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  mockSpawnHappyCLI: vi.fn(),
  mockIsRunning: vi.fn(),
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.mockSpawnHappyCLI,
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsRunning,
  checkIfDaemonRunningAndCleanupStaleState: vi.fn().mockResolvedValue(false),
}))

import { ensureDaemonRunning } from './ensureDaemonRunning'

const MESSAGE = 'The background daemon is not available in this build.'
const BIN = join(__dirname, '..', '..', 'bin', 'happy.mjs')

describe('daemon disabled', () => {
  it('ensureDaemonRunning never spawns a daemon', async () => {
    mocks.mockIsRunning.mockResolvedValue(false)

    await expect(ensureDaemonRunning()).resolves.toBeUndefined()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
  })

  it.each(['start', 'start-sync', 'status', 'list', 'stop', 'install', 'logs', 'bogus'])(
    'happycc daemon %s exits 1 with the unavailable message',
    (sub: string) => {
      const home = mkdtempSync(join(tmpdir(), 'happy-daemon-disabled-'))
      try {
        const result = spawnSync(process.execPath, [BIN, 'daemon', sub], {
          encoding: 'utf8',
          env: { ...process.env, HAPPY_SERVER_URL: 'http://127.0.0.1:9', HAPPY_HOME_DIR: home },
          timeout: 30000,
        })
        expect(result.stderr).toContain(MESSAGE)
        expect(result.status).toBe(1)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  )
})
