/**
 * Talking to a model.
 *
 * The vocabulary an adapter speaks — messages in, {@link StreamChunk}s out —
 * plus the two adapters the harness ships with. Deliberately ignorant of the
 * session log: see `@harness/exchange` for the half that writes things down.
 *
 * @module @harness/llm
 */

export { createOpenAiAdapter } from './openai.ts'
export type { OpenAiAdapterOptions } from './openai.ts'
export { createScriptedAdapter, splitIntoDeltas } from './scripted.ts'
export type { ScriptedAdapterOptions } from './scripted.ts'
export { ModelStreamError } from './types.ts'
export type {
  MessageRole,
  ModelAdapter,
  ModelMessage,
  ReasoningEffort,
  StreamChunk,
  StreamChunkType,
  StreamOptions,
} from './types.ts'
