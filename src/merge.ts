/** Union-by-id merge for 409 recovery: local versions win per id, remote
 *  order kept, local-only elements appended. Both sides' work survives;
 *  deletions are not tracked (documented limitation). Shared by the viewer
 *  (client merge) and verifiable from Node (dist/merge.js). */
export function mergeElements(
  remote: Record<string, unknown>[],
  local: Record<string, unknown>[],
): Record<string, unknown>[] {
  const localById = new Map(local.map((e) => [String(e.id), e]));
  const merged = remote.map((e) => localById.get(String(e.id)) ?? e);
  const remoteIds = new Set(remote.map((e) => String(e.id)));
  for (const e of local) {
    if (!remoteIds.has(String(e.id))) merged.push(e);
  }
  return merged;
}
