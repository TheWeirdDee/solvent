export function formatSats(n: number): string {
  return `${n.toLocaleString('en-US')} sats`;
}

export function truncateHex(hex: string, head = 8, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

