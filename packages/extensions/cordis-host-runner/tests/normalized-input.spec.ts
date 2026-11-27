/** Object-root gating for model-emitted JSON-encoded inspect input. */
import { describe, expect, it } from 'vitest'
import { normalizeEncodedInput } from '../src/normalized-input.ts'

const objectRoot = { type: 'object' }
const nonObjectRoots: ({ type?: string } | undefined)[] = [{ type: 'string' }, {}, undefined]
const nonObjectJson = ['not json', '[]', 'null', '"text"', '5']

describe('normalizeEncodedInput', () => {
  it('decodes a JSON-encoded object for an object-root schema', () => {
    expect(normalizeEncodedInput(objectRoot, '{"service":"tools"}')).toEqual({ service: 'tools' })
  })

  it('leaves a string unchanged for a non-object root schema', () => {
    for (const inputSchema of nonObjectRoots) {
      expect(normalizeEncodedInput(inputSchema, '{"service":"tools"}')).toBe('{"service":"tools"}')
    }
  })

  it.each(nonObjectJson)('leaves non-object JSON %s unchanged', (input) => {
    expect(normalizeEncodedInput(objectRoot, input)).toBe(input)
  })

  it('leaves non-string input unchanged', () => {
    const input = { service: 'tools' }
    expect(normalizeEncodedInput(objectRoot, input)).toBe(input)
    expect(normalizeEncodedInput(objectRoot, undefined)).toBeUndefined()
  })
})
