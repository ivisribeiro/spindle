/**
 * A verified_by value worth existence-checking on disk: a single POSIX repo-relative
 * path token. Everything else is ACCEPTED WITHOUT a check rather than false-blocked —
 * a command has a space ("npm run e2e"), a URL has a scheme ("http://…"), a Windows
 * path has a backslash/drive ("C:\\…", "src\\a"), and a bare version is a dotted
 * NUMBER ("v1.2", "1.0"). Only a separator or a real (letter-led) file extension on
 * an otherwise plain token counts. (dogfood: adversary-confirmed false-block vectors.)
 */
export function looksLikePath(v: string): boolean {
  if (v.includes(' ')) return false; // command
  if (v.includes('://')) return false; // URL citation
  if (v.includes('\\')) return false; // Windows path — not a POSIX repo path
  if (/^[a-zA-Z]:/.test(v)) return false; // Windows drive letter
  // extension must start with a LETTER, so "v1.2" / "1.0" are not read as paths
  return v.includes('/') || /\.[a-z][a-z0-9]{0,5}$/i.test(v);
}
