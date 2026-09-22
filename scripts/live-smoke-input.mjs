function containsMarker(value, candidates) {
  if (typeof value === "string") {
    return candidates.some((candidate) => value.includes(candidate));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsMarker(item, candidates));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) =>
      containsMarker(item, candidates),
    );
  }
  return false;
}

export function toolInputContainsMarker(input, marker) {
  const candidates = [marker, JSON.stringify(marker).slice(1, -1)];
  if (typeof input !== "string") return containsMarker(input, candidates);

  try {
    return containsMarker(JSON.parse(input), candidates);
  } catch {
    return containsMarker(input, candidates);
  }
}
