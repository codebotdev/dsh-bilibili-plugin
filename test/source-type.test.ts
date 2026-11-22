import { describe, expect, it } from 'vitest';
import { commentSourceType } from '../src/client/source-type.js';

describe('comment source tags', () => {
  it.each([
    ['1', 'video'], ['11', 'dynamic'], ['12', '专栏'], ['14', '音频'],
    ['16', 'dynamic'], ['17', 'dynamic'], ['22', '漫画'], ['33', '课程'],
  ])('uses business type %s for original content', (businessId, expected) => {
    expect(commentSourceType(`${businessId}_123_456`, '')).toBe(expected);
  });

  it.each([
    ['https://www.bilibili.com/video/BV123/', 'video'],
    ['https://www.bilibili.com/opus/123#reply456', 'dynamic'],
    ['https://t.bilibili.com/123', 'dynamic'],
    ['https://m.bilibili.com/read/cv123', '专栏'],
    ['https://www.bilibili.com/audio/au123', '音频'],
    ['', '内容'], ['invalid', '内容'],
    ['https://example.com/video/BV123', '内容'],
    ['https://www.bilibili.com/unknown', '内容'],
    ['javascript:alert(1)', '内容'],
  ])('handles legacy source URL %s', (uri, expected) => {
    expect(commentSourceType('legacy', uri)).toBe(expected);
  });
});
