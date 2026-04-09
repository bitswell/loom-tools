/**
 * Parse git commit trailers from raw trailer output.
 *
 * Expects the format produced by `git log --format=%(trailers)`:
 * each line is `Key: value`.
 */
export function parseTrailers(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse git commit trailers, preserving repeated keys.
 *
 * Unlike parseTrailers, this returns all values for each key in the
 * order they appear. Needed for trailers like Key-Finding that the
 * LOOM protocol allows to repeat on a single commit.
 */
export function parseTrailersMulti(raw: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) {
      if (result[key]) {
        result[key].push(value);
      } else {
        result[key] = [value];
      }
    }
  }
  return result;
}
