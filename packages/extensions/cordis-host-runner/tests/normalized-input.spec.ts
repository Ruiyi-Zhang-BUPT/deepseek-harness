/** Object-root gating for model-emitted JSON-encoded inspect input. */
import { describe, expect, it } from 'vitest'
import { normalizeEncodedInput } from '../src/normalized-input.ts'

const objectRoot = { type: 'object' }

describe('normalizeEncodedInput', () => {
  it('decodes a JSON-encoded object for an object-root schema', () => {
    expect(normalizeEncodedInput(objectRoot, '{"service":"tools"}')).toEqual({ service: 'tools' })
  })

  it.each([
    ['a non-object root schema', { type: 'string' }],
    ['an untyped root schema', {}],
    ['an absent root schema', undefined],
  ])('leaves a string unchanged for %s', (_label, inputSchema) => {
    expect(normalizeEncodedInput(inputSchema, '{"service":"tools"}')).toBe('{"service":"tools"}')
  })

  it.each(['not json', '[]', 'null', '"text"', '5'])('leaves non-object JSON %s unchanged', (input) => {
    expect(normalizeEncodedInput(objectRoot, input)).toBe(input)
  })

  it('leaves non-string input unchanged', () => {
    const input = { service: 'tools' }
    expect(normalizeEncodedInput(objectRoot, input)).toBe(input)
    expect(normalizeEncodedInput(objectRoot, undefined)).toBeUndefined()
  })
})
