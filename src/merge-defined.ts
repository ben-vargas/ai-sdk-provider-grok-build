/** @internal Merge own enumerable properties without letting `undefined` erase defaults. */
export function mergeDefined<T extends object>(
  base: T,
  override: Partial<T>,
): T {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
