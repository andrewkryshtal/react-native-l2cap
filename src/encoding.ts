/**
 * Tiny zero-dependency helpers for moving payloads between JS strings,
 * hex strings and `ArrayBuffer`s — useful when wiring L2CAP traffic to a UI
 * or a debug log.
 *
 * All functions are pure and synchronous. UTF-8 encoding/decoding is
 * implemented inline so the library does not depend on the
 * `TextEncoder`/`TextDecoder` globals (which are present in Hermes ≥ 0.74
 * but not in every JS engine we may run under).
 */

/**
 * Encode a JS string as a UTF-8 `ArrayBuffer`.
 *
 * @example
 *   L2cap.sendData(stringToBuffer('hello'))
 */
export function stringToBuffer(text: string): ArrayBuffer {
  const bytes = encodeUtf8(text)
  const buffer = new ArrayBuffer(bytes.length)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

/**
 * Decode an `ArrayBuffer` containing UTF-8 bytes into a JS string.
 * Invalid sequences are replaced with `U+FFFD`.
 */
export function bufferToString(buffer: ArrayBuffer): string {
  return decodeUtf8(new Uint8Array(buffer))
}

/**
 * Format an `ArrayBuffer` as a hex string.
 *
 * @param separator inserted between each byte. Defaults to a single space
 *                  for human-readable logs; pass `''` for compact output.
 *
 * @example
 *   bufferToHex(buf)      // -> "de ad be ef"
 *   bufferToHex(buf, '')  // -> "deadbeef"
 */
export function bufferToHex(buffer: ArrayBuffer, separator: string = ' '): string {
  const view = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < view.length; i++) {
    if (i > 0) out += separator
    out += view[i]!.toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Parse a hex string into an `ArrayBuffer`.
 *
 * Whitespace, `:`, `-` and `_` characters are stripped before parsing, so
 * `"de:ad-be ef"` and `"deadbeef"` both decode to the same 4 bytes.
 *
 * @throws when the cleaned input has an odd length or contains
 *         non-hex characters.
 */
export function hexToBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/[\s:_-]/g, '')
  if (clean.length === 0) return new ArrayBuffer(0)
  if (clean.length % 2 !== 0) {
    throw new Error(`hexToBuffer: input has odd length (${clean.length})`)
  }
  const buffer = new ArrayBuffer(clean.length / 2)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < view.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBuffer: invalid hex pair at offset ${i * 2}`)
    }
    view[i] = byte
  }
  return buffer
}

// --- Internals --------------------------------------------------------

function encodeUtf8(input: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return new Uint8Array(out)
}

function decodeUtf8(view: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < view.length) {
    const b = view[i++]!
    if (b < 0x80) {
      out += String.fromCharCode(b)
    } else if (b < 0xc0) {
      out += '\ufffd'
    } else if (b < 0xe0 && i < view.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (view[i++]! & 0x3f))
    } else if (b < 0xf0 && i + 1 < view.length) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((view[i++]! & 0x3f) << 6) | (view[i++]! & 0x3f)
      )
    } else if (i + 2 < view.length) {
      const cp =
        ((b & 0x07) << 18) |
        ((view[i++]! & 0x3f) << 12) |
        ((view[i++]! & 0x3f) << 6) |
        (view[i++]! & 0x3f)
      const adj = cp - 0x10000
      out += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff))
    } else {
      out += '\ufffd'
      break
    }
  }
  return out
}
