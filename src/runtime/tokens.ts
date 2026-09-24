// Conservative token estimate: ~3 bytes per token, rounded up.
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text ?? '', 'utf8') / 3);
}
