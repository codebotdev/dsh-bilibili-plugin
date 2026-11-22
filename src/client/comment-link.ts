/** Recent record keys are businessId_oid_sourceId; use the exact current comment ID. */
export function commentLink(uri: string, recordId: string): string | undefined {
  const identity = /^(1|11|12|14|16|17|22|33)_[1-9]\d*_([1-9]\d*)$/.exec(recordId);
  const sourceId = identity?.[2];
  if (!uri || !sourceId) return;
  try {
    const url = new URL(uri);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)) return;
    const video = identity?.[1] === '1' && /^\/video\/[^/]+\/?$/.test(url.pathname);
    const opus = /^\/opus\/[1-9]\d*\/?$/.test(url.pathname);
    if (!video && !opus) return;
    url.hash = `reply${sourceId}`;
    return url.href;
  } catch {
    return;
  }
}
