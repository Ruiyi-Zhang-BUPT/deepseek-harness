/** Decode the JSON-encoded object a model can pass for an object-rooted inspect input. */

/**
 * Decode a model-supplied input string when the method's root schema requires an object.
 *
 * A raw string can never satisfy an object schema, so decoding it here cannot lose a valid value.
 * Values that are not a JSON-encoded object are returned unchanged for the caller's schema
 * validation to reject with its existing diagnostic.
 *
 * @param inputSchema - method's root input schema; only an object root permits decoding.
 * @param input - model-supplied input, possibly a JSON-encoded object string.
 * @returns the decoded plain object, or the original input when it is not an encoded object.
 */
export function normalizeEncodedInput(inputSchema: { type?: string } | undefined, input: unknown): unknown {
  if (typeof input !== 'string' || inputSchema?.type !== 'object') return input
  let decoded: unknown
  try {
    decoded = JSON.parse(input)
  } catch {
    // Not JSON: the caller's schema validation still rejects the original string.
    return input
  }
  return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? decoded : input
}
