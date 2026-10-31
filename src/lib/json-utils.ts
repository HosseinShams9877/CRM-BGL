export function parseJsonColumn(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const first: unknown = JSON.parse(raw);
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return first as Record<string, unknown>;
    }
    // legacy double-encoded row: first parse yields a string — unfold once more
    if (typeof first === 'string') {
      try {
        const second: unknown = JSON.parse(first);
        if (second && typeof second === 'object' && !Array.isArray(second)) {
          return second as Record<string, unknown>;
        }
      } catch { /* not JSON — treat as empty */ }
    }
  } catch { /* not JSON — treat as empty */ }
  return {};
}