/**
 * The request, cut into blocks and put back together.
 *
 * One property, asserted from several directions: what the column paints is
 * exactly `JSON.stringify(messages, null, 2)`. The blocks exist so each
 * message can be a different colour, and a colouring scheme that quietly
 * changed a character would turn the right-hand column into a plausible
 * fiction — which is the one thing it must never be.
 */

import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '@harness/exchange'
import { modelViewBlocks, modelViewJson } from '../src/model-view.ts'

const CONVERSATIONS: readonly (readonly ModelMessage[])[] = [
  [],
  [{ role: 'user', content: 'hello' }],
  [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'again' },
  ],
  // The characters a naive serialiser gets wrong: quotes, backslashes, real
  // newlines, a tab, an emoji, and CJK.
  [{ role: 'user', content: 'a "quote", a \\ and\na newline\twith 世界 🎈' }],
  [{ role: 'assistant', content: '' }],
]

describe('the rendered request', () => {
  it.each(CONVERSATIONS.map((messages, index) => [index, messages] as const))(
    'is byte-identical to the JSON of conversation %i',
    (_index, messages) => {
      expect(modelViewJson(messages)).toBe(JSON.stringify(messages, null, 2))
    },
  )

  it('is assembled from the blocks the column paints, not beside them', () => {
    const messages = CONVERSATIONS[2] as readonly ModelMessage[]
    const blocks = modelViewBlocks(messages)

    // Exactly what the panel does with them: frame, blocks, separators.
    const painted = `[\n${blocks.map((block) => block.json).join(',\n')}\n]`

    expect(painted).toBe(modelViewJson(messages))
    expect(painted).toBe(JSON.stringify(messages, null, 2))
  })

  it('says `[]` for a conversation that has not started', () => {
    expect(modelViewJson([])).toBe('[]')
    expect(modelViewBlocks([])).toEqual([])
  })
})

describe('a block', () => {
  it('carries the role, so the column can colour it', () => {
    const blocks = modelViewBlocks([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])

    expect(blocks.map((block) => [block.index, block.role])).toEqual([
      [0, 'user'],
      [1, 'assistant'],
    ])
  })

  it('is the message itself, not a description of it', () => {
    const message: ModelMessage = { role: 'user', content: 'hello' }

    const [block] = modelViewBlocks([message])

    expect(JSON.parse(block?.json ?? '')).toEqual(message)
  })

  it('cannot be edited into a second version of the request', () => {
    const blocks = modelViewBlocks([{ role: 'user', content: 'hello' }])

    expect(Object.isFrozen(blocks)).toBe(true)
    expect(Object.isFrozen(blocks[0])).toBe(true)
  })
})

describe('a request that used tools', () => {
  const withTools: readonly ModelMessage[] = [
    { role: 'user', content: 'what is in src?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'list_directory', arguments: '{"path":"src"}' }],
    },
    { role: 'tool', content: 'index.ts', toolCallId: 'call_1' },
    { role: 'assistant', content: 'One file: index.ts.' },
  ]

  it('shows the calls and the result, because they are in the request', () => {
    const json = modelViewJson(withTools)

    expect(json).toContain('"toolCalls"')
    expect(json).toContain('"toolCallId": "call_1"')
    expect(json).toContain('"list_directory"')
  })

  it('is still the request byte for byte', () => {
    // The claim the column exists for, restated for the shapes this step
    // added: nothing about a tool message is summarised on the way to screen.
    expect(modelViewJson(withTools)).toBe(JSON.stringify(withTools, null, 2))
  })

  it('gives a tool message its own role to be coloured by', () => {
    expect(modelViewBlocks(withTools).map((block) => block.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })
})
