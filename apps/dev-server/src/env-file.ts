/**
 * Configuration from a file, so a key is something you keep rather than
 * something you retype.
 *
 * `HARNESS_API_KEY=sk-... pnpm dev` works and stays the documented way to run
 * one-off. It is a poor way to run every day: the key ends up in shell
 * history, in the process table, and eventually in a screenshot. A file that
 * git is told to ignore is the same secret with none of those exits.
 *
 * The rules, in the order they matter:
 *
 * - **The shell wins.** A variable already in the environment is never
 *   replaced by the file, so `HARNESS_MODEL=... pnpm dev` still overrides a
 *   committed default without editing anything. This is `process.loadEnvFile`'s
 *   own behaviour, and the reason the loading is delegated to it rather than
 *   hand-rolled.
 * - **No file is not an error.** The scripted adapter is the default for a
 *   reason; a fresh clone runs with no `.env` at all.
 * - **A file that was asked for and is missing _is_ an error.** Setting
 *   `HARNESS_ENV_FILE` and silently ignoring it would boot the fake while the
 *   operator believed they were talking to a provider — the same failure
 *   `adapterFromEnv` refuses when a key arrives without a model.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** Where to look, and what to do when something is found. */
export interface EnvFileOptions {
  /** Explicit file to load. Usually `HARNESS_ENV_FILE`. */
  readonly path?: string | undefined
  /** Directory the upward search starts from. Defaults to the cwd. */
  readonly from?: string | undefined
  /** Injected for tests. Defaults to `process.loadEnvFile`. */
  readonly load?: ((path: string) => void) | undefined
}

/** The file this repo looks for when nothing points anywhere else. */
export const ENV_FILE_NAME = '.env'

/**
 * Load a `.env` into `process.env`, if there is one.
 *
 * Searches upward from the working directory, because `pnpm dev:server` runs
 * with the cwd inside `apps/dev-server` while the file people actually write
 * sits at the root of the workspace. The first hit wins and the walk stops —
 * merging several files would make "where did this value come from?" a
 * question with more than one answer.
 *
 * @param options - an explicit path, a starting directory, or neither.
 * @returns the absolute path of the file that was loaded, or `undefined` when
 *   there was none to load.
 * @throws when {@link EnvFileOptions.path} names a file that does not exist.
 */
export function loadEnvFile(options: EnvFileOptions = {}): string | undefined {
  const load = options.load ?? ((path: string) => process.loadEnvFile(path))
  const from = resolve(options.from ?? process.cwd())

  const requested = nonEmpty(options.path)
  if (requested !== undefined) {
    const path = resolve(from, requested)
    if (!existsSync(path)) {
      throw new Error(`env file ${path} does not exist; refusing to boot as if it were empty`)
    }
    load(path)
    return path
  }

  const found = findUpwards(from, ENV_FILE_NAME)
  if (found === undefined) return undefined
  load(found)
  return found
}

/**
 * The nearest ancestor directory containing `name`, including `from` itself.
 *
 * @param from - absolute directory to start at.
 * @param name - the file to look for.
 * @returns the absolute path of the file, or `undefined` at the root.
 */
function findUpwards(from: string, name: string): string | undefined {
  let directory = from
  for (;;) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    // `dirname` of the root is the root, which is the only way this ends.
    if (parent === directory) return undefined
    directory = parent
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * The shortest honest way to write a path in the boot banner.
 *
 * Both forms name the same file, so the only question is which one a reader
 * can act on. Nearby, the relative form wins — `../../.env` says "the one at
 * the root of the workspace" at a glance. Far away it loses badly, and
 * `../../../../../../../tmp/x.env` is not a path anyone can follow. Length is
 * a good enough proxy for the difference, and it never leaves the reader
 * guessing which file was meant.
 *
 * @param path - an absolute path.
 * @param from - the directory to write it relative to. Defaults to the cwd.
 * @returns whichever of the two forms is shorter.
 */
export function describePath(path: string, from: string = process.cwd()): string {
  const nearby = relative(from, path)
  return nearby.length > 0 && nearby.length < path.length ? nearby : path
}
