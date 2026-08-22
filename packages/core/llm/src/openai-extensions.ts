/**
 * The fields providers added after the SDK's types were written.
 *
 * Reasoning is not an exotic extension any more. OpenAI, DeepSeek, Moonshot,
 * MiniMax, Qwen and xAI all take `reasoning_effort` as a top-level string, and
 * the SDK declares that one itself — this file does not redeclare it. What the
 * SDK does not have is the rest of the dialect, because it types the surface
 * OpenAI itself serves: DeepSeek's `thinking` switch, and the
 * `reasoning_content` that comes back. Without them the provider's own
 * published example does not compile.
 *
 * Declaration merging rather than a cast at each call site. A cast is a claim
 * made once and forgotten — invisible to the next reader, checked by nothing.
 * This is a declaration, written where somebody looking for it will find it,
 * and every `delta.reasoning_content` in the codebase is checked against it.
 * When the SDK types these itself the duplication becomes a compile error
 * rather than a silent divergence, which is the notification we want.
 *
 * Only what the harness sends and reads is declared. The convergence is real
 * but not total, and the differences are worth knowing before assuming a field
 * is portable: Qwen spells the switch `enable_thinking` and adds a numeric
 * `thinking_budget`; MiniMax asks for `reasoning_split` and answers with a
 * `reasoning_details` array rather than a string; OpenAI and xAI return no
 * reasoning text at all from chat completions, only a token count. Declaring
 * those here would be typing a wire we have never put a byte on.
 *
 * The augmentation names the module the interfaces are *declared* in, not the
 * one they are re-exported from: merging happens at the declaration site.
 *
 * @see https://api-docs.deepseek.com/guides/thinking_mode/
 * @module
 */

import type { ChatCompletionChunk as Chunk } from 'openai/resources/chat/completions'

declare module 'openai/resources/chat/completions/completions' {
  interface ChatCompletionCreateParamsBase {
    /**
     * Whether the model should reason before answering.
     *
     * DeepSeek's spelling, and a switch rather than a dial — `reasoning_effort`
     * is the dial. `deepseek-v4-pro` reasons by default, so `disabled` is the
     * value that changes anything.
     *
     * @see https://api-docs.deepseek.com/guides/thinking_mode/
     */
    thinking?: { type: 'enabled' | 'disabled' }
  }

  interface ChatCompletionMessage {
    /** The model's reasoning, when it was asked to show it. */
    reasoning_content?: string | null
  }

  namespace ChatCompletionChunk {
    namespace Choice {
      interface Delta {
        /** A piece of the reasoning, streamed like any other delta. */
        reasoning_content?: string | null
      }
    }
  }
}

/**
 * A streamed delta, including the reasoning field the augmentation adds.
 *
 * Exported so this file is a module — which is what makes the block above an
 * augmentation rather than a redeclaration of the SDK's own module — and
 * because naming the type is worth doing anyway.
 */
export type StreamedDelta = Chunk.Choice.Delta
