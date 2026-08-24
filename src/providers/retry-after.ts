const MAX_HONOURED_MS = 60_000;

interface HeaderBag {
  get(name: string): string | null;
}

function isHeaderBag(value: unknown): value is HeaderBag {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    typeof value.get === 'function'
  );
}

/**
 * Reads a Retry-After header into milliseconds.
 *
 * Accepts both forms the spec allows, a delay in seconds and an HTTP date.
 * Returns undefined when the header is absent or unparseable, and clamps
 * absurd values so a misbehaving upstream cannot pin a request open.
 */
export function retryAfterMs(
  headers: unknown,
  now: number,
): number | undefined {
  if (!isHeaderBag(headers)) {
    return undefined;
  }

  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return clamp(seconds * 1000);
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return clamp(date - now);
}

function clamp(ms: number): number | undefined {
  if (ms <= 0) {
    return 0;
  }
  return Math.min(ms, MAX_HONOURED_MS);
}
