export function formatSats(n: number): string {
  return `${n.toLocaleString('en-US')} sats`;
}

export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined) return '?';
  if (ratio === Infinity) return '∞';
  return `${ratio.toFixed(2)}×`;
}

export function truncateHex(hex: string, head = 8, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function formatRelativeTime(unixSeconds: number, nowSeconds: number): string {
  const diff = nowSeconds - unixSeconds;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} minute${Math.floor(diff / 60) === 1 ? '' : 's'} ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hour${Math.floor(diff / 3600) === 1 ? '' : 's'} ago`;
  return `${Math.floor(diff / 86400)} day${Math.floor(diff / 86400) === 1 ? '' : 's'} ago`;
}

export function formatCountdown(unixSeconds: number, nowSeconds: number): string {
  const diff = unixSeconds - nowSeconds;
  if (diff <= 0) return 'expired';
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}
