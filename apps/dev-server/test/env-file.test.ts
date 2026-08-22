import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describePath, loadEnvFile } from '../src/env-file.ts'

/** A throwaway tree, so the search walks real directories. */
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-env-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Records what was asked for instead of touching the real `process.env`. */
function recorder(): { loaded: string[]; load: (path: string) => void } {
  const loaded: string[] = []
  return { loaded, load: (path) => void loaded.push(path) }
}

describe('loadEnvFile', () => {
  it('loads a .env sitting in the working directory', () => {
    const path = join(root, '.env')
    writeFileSync(path, 'HARNESS_MODEL=gpt-4o-mini\n')
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: root, load })).toBe(path)
    expect(loaded).toEqual([path])
  })

  it('walks up to the workspace root, because pnpm runs in the package', () => {
    // What `pnpm dev:server` actually does: cwd is apps/dev-server, and the
    // file people write is two directories above it.
    const path = join(root, '.env')
    writeFileSync(path, 'HARNESS_MODEL=gpt-4o-mini\n')
    const cwd = join(root, 'apps', 'dev-server')
    mkdirSync(cwd, { recursive: true })
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: cwd, load })).toBe(path)
    expect(loaded).toEqual([path])
  })

  it('stops at the nearest file rather than merging every one it passes', () => {
    writeFileSync(join(root, '.env'), 'HARNESS_MODEL=outer\n')
    const cwd = join(root, 'apps', 'dev-server')
    mkdirSync(cwd, { recursive: true })
    const nearest = join(cwd, '.env')
    writeFileSync(nearest, 'HARNESS_MODEL=inner\n')
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: cwd, load })).toBe(nearest)
    expect(loaded).toEqual([nearest])
  })

  it('reports no file at all, because a fresh clone has none', () => {
    // Nothing above a temp directory has a .env, so the walk reaches the root.
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: root, load })).toBeUndefined()
    expect(loaded).toEqual([])
  })

  it('loads an explicitly named file, resolved against the cwd', () => {
    const path = join(root, 'secrets.env')
    writeFileSync(path, 'HARNESS_MODEL=gpt-4o-mini\n')
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: root, path: 'secrets.env', load })).toBe(path)
    expect(loaded).toEqual([path])
  })

  it('prefers the named file over one it would have found by walking', () => {
    writeFileSync(join(root, '.env'), 'HARNESS_MODEL=found\n')
    const named = join(root, 'secrets.env')
    writeFileSync(named, 'HARNESS_MODEL=named\n')
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: root, path: named, load })).toBe(named)
    expect(loaded).toEqual([named])
  })

  it('refuses a named file that is missing rather than booting the fake', () => {
    const { loaded, load } = recorder()

    expect(() => loadEnvFile({ from: root, path: 'nowhere.env', load })).toThrow(/does not exist/)
    expect(loaded).toEqual([])
  })

  it.each([
    ['an empty path', ''],
    ['a whitespace path', '  '],
    ['an unset path', undefined],
  ])('treats %s as no request at all', (_label, path) => {
    // An unset HARNESS_ENV_FILE is the common case and must not throw.
    const { loaded, load } = recorder()

    expect(loadEnvFile({ from: root, path, load })).toBeUndefined()
    expect(loaded).toEqual([])
  })

  it('leaves a variable the shell already set alone', () => {
    // The one behaviour worth checking against the real loader: a file must
    // never overrule the command that started the process.
    const path = join(root, '.env')
    writeFileSync(path, 'HARNESS_ENV_FILE_TEST=from-file\nHARNESS_ENV_FILE_ONLY=from-file\n')
    process.env.HARNESS_ENV_FILE_TEST = 'from-shell'

    try {
      expect(loadEnvFile({ from: root })).toBe(path)
      expect(process.env.HARNESS_ENV_FILE_TEST).toBe('from-shell')
      expect(process.env.HARNESS_ENV_FILE_ONLY).toBe('from-file')
    } finally {
      delete process.env.HARNESS_ENV_FILE_TEST
      delete process.env.HARNESS_ENV_FILE_ONLY
    }
  })
})

describe('describePath', () => {
  it('writes a path inside the working directory relatively', () => {
    expect(describePath('/work/repo/.env', '/work/repo')).toBe('.env')
    expect(describePath('/work/repo/apps/dev-server/.env', '/work/repo')).toBe(
      'apps/dev-server/.env',
    )
  })

  it('climbs to a near ancestor, which is what pnpm dev:server does', () => {
    // cwd is the package; the file people write is at the workspace root.
    expect(describePath('/work/repo/.env', '/work/repo/apps/dev-server')).toBe('../../.env')
  })

  it('writes a far-off path absolutely, rather than as a ladder of dots', () => {
    expect(describePath('/tmp/smoke/.env', '/work/repo/apps/dev-server')).toBe('/tmp/smoke/.env')
  })

  it('writes the working directory itself absolutely, having nothing shorter', () => {
    expect(describePath('/work/repo', '/work/repo')).toBe('/work/repo')
  })
})
