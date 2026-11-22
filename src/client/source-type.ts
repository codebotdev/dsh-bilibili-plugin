/** Recover the content type when a notification is labelled only as a comment. */
export function commentSourceType(recordId: string, uri: string): string {
  const businessId = /^(1|11|12|14|16|17|22|33)_[1-9]\d*_[1-9]\d*$/.exec(recordId)?.[1];
  const types: Record<string, string> = {
    '1': 'video', '11': 'dynamic', '12': '专栏', '14': '音频',
    '16': 'dynamic', '17': 'dynamic', '22': '漫画', '33': '课程',
  };
  if (businessId) return types[businessId];
  try {
    const url = new URL(uri);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '内容';
    if (url.hostname === 't.bilibili.com' && /^\/[1-9]\d*\/?$/.test(url.pathname)) return 'dynamic';
    if (!['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)) return '内容';
    if (/^\/video\/[^/]+\/?$/.test(url.pathname)) return 'video';
    if (/^\/opus\/[1-9]\d*\/?$/.test(url.pathname)) return 'dynamic';
    if (/^\/read\/cv[1-9]\d*\/?$/.test(url.pathname)) return '专栏';
    if (/^\/audio\/au[1-9]\d*\/?$/.test(url.pathname)) return '音频';
  } catch { /* Historical records may have no usable source address. */ }
  return '内容';
}
