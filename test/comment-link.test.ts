import { describe, expect, it } from 'vitest';
import { commentLink } from '../src/client/comment-link.js';

const video = 'https://www.bilibili.com/video/BV1YpH166Ekf/';
const key = '1_117399760143200_320525339873';

describe('recent comment links', () => {
  it('builds a message-content link to the current comment, including historical records', () => {
    expect(commentLink(video, key)).toBe(`${video}#reply320525339873`);
  });
  it('preserves query parameters and replaces an old fragment without appending a second one', () => {
    expect(commentLink(`${video}?p=2#reply999`, key)).toBe(`${video}?p=2#reply320525339873`);
    expect(commentLink(`${video}#reply320525339873`, key)).toBe(`${video}#reply320525339873`);
  });
  it('preserves large comment IDs as exact strings', () => {
    expect(commentLink(video, '1_117399760143200_90071992547409931234')).toBe(`${video}#reply90071992547409931234`);
  });
  it.each(['11', '12', '16', '17'])('adds the exact comment ID to opus links for business type %s', business => {
    const opus = 'https://www.bilibili.com/opus/1273148346619396113';
    expect(commentLink(opus, `${business}_90071992547409931234_321022739665`)).toBe(`${opus}#reply321022739665`);
    expect(commentLink(`${opus}?from=notify#old`, `${business}_123_321022739665`)).toBe(`${opus}?from=notify#reply321022739665`);
  });
  it.each(['11_123_', '11_123_undefined', '11_123_0', 'legacy'])('omits opus links when the comment ID is missing or invalid: %s', recordId => {
    expect(commentLink('https://www.bilibili.com/opus/1273148346619396113', recordId)).toBeUndefined();
  });
  it.each(['https://example.com/opus/123', 'https://www.bilibili.com/opus/not-an-id'])('rejects unsupported opus addresses: %s', uri => {
    expect(commentLink(uri, '11_123_456')).toBeUndefined();
  });
  it.each(['legacy', '1_117399760143200_', '1_117399760143200_undefined', '1_117399760143200_0', '1_117399760143200_-1', '1_117399760143200_3.2'])('omits the message link without a valid sourceId: %s', recordId => {
    expect(commentLink(`${video}#original`, recordId)).toBeUndefined();
  });
  it.each([
    ['', key], ['not a URL', key], ['bilibili://video/117399760143200', key],
    ['https://t.bilibili.com/123', '11_123_456'], [video, '11_123_456'],
    ['https://example.com/video/BV1YpH166Ekf/', key], ['https://www.bilibili.com/read/cv123', key],
  ])('omits message links for missing or unsupported addresses: %s', (uri, recordId) => {
    expect(commentLink(uri, recordId)).toBeUndefined();
  });
});
