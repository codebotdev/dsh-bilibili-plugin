import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BILIBILI_LOGO_SVG, BILIBILI_LOGO_URI, bilibiliTitle, installSessionLogo } from '../src/client/session-logo.js';

const MARK = 'data-bilibili-session-logo';
const TEXT = 'data-bilibili-session-text';
let dom: JSDOM;
let images: HTMLImageElement[];
let disposers: Array<() => void>;
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
const title = (id = 'bili') => dom.window.document.getElementById(id)!;
const install = () => {
  const dispose = installSessionLogo(dom.window.document);
  disposers.push(dispose);
  return dispose;
};
const load = async () => { images.forEach(image => image.dispatchEvent(new dom.window.Event('load'))); await tick(); };
beforeEach(() => {
  images = []; disposers = [];
  dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div role="treeitem" aria-selected="false" class="_sessionRow_dsh_10" draggable="true"><span class="_title_dsh_20" id="bili">B站 video: 视频标题</span><button id="menu">操作</button></div>
    <div role="treeitem" aria-selected="true" class="_dsh_sessionRow"><span class="_dsh_title" id="normal">普通会话</span></div>
    <button role="treeitem" aria-selected="false" class="_searchResultRow_10"><span class="_searchResultHeading_11"><span class="_searchResultTitle_12" id="search">B站 dynamic: 动态标题</span></span></button>
    <div role="treeitem" aria-selected="false" class="YDXeBa_searchResultRow"><span class="YDXeBa_searchResultHeading"><span class="YDXeBa_searchResultTitle" id="current-search">B站 dynamic: 当前宿主搜索</span></span></div>
    <p id="message">B站 video: 聊天正文</p>
  </body></html>`);
  Object.defineProperty(dom.window, 'CSS', { value: { supports: () => true }, configurable: true });
  const originalImage = dom.window.Image;
  Object.defineProperty(dom.window, 'Image', { value: function () {
    const image = new originalImage(); images.push(image); return image;
  } });
});
afterEach(() => { disposers.forEach(dispose => dispose()); dom.window.close(); });

describe('B站会话 SVG logo (dsh-im presentation adapter)', () => {
  it('embeds the supplied SVG and decorates session/search titles only after successful image load', async () => {
    const original = title().firstChild;
    const originalText = title().textContent;
    let opened = 0;
    title().parentElement!.addEventListener('click', () => opened++);
    install();
    await tick();
    expect(title().hasAttribute(MARK)).toBe(false);
    expect(images[0].src).toBe(BILIBILI_LOGO_URI);
    expect(BILIBILI_LOGO_SVG).toContain('viewBox="0 0 24 24"');
    expect(BILIBILI_LOGO_SVG).toContain('fill="rgba(0,174,236,1)"');
    await load();
    expect(title().getAttribute(TEXT)).toBe('视频标题');
    expect(title('search').getAttribute(TEXT)).toBe('动态标题');
    expect(title('current-search').getAttribute(TEXT)).toBe('当前宿主搜索');
    expect(title('normal').hasAttribute(MARK)).toBe(false);
    expect(title('message').hasAttribute(MARK)).toBe(false);
    expect(title().firstChild).toBe(original);
    expect(title().textContent).toBe(originalText);
    expect(dom.window.document.querySelectorAll('svg')).toHaveLength(0);
    title().dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    expect(opened).toBe(1);
    expect(title().parentElement!.getAttribute('draggable')).toBe('true');
    expect(dom.window.document.head.textContent).toContain('pointer-events: none');
    expect(dom.window.document.head.textContent).toContain('[data-scrolled]');
  });

  it('tracks title updates, inserted rows, rename fields and nodes moved outside the session tree', async () => {
    install(); await load();
    title().firstChild!.textContent = 'B站 · 新标题';
    await tick();
    expect(title().getAttribute(TEXT)).toBe('新标题');
    title().innerHTML = '<input value="重命名">';
    await tick();
    expect(title().hasAttribute(MARK)).toBe(false);
    title().textContent = 'B站 article: 专栏';
    await tick();
    expect(title().getAttribute(TEXT)).toBe('专栏');
    dom.window.document.body.appendChild(title());
    await tick();
    expect(title().hasAttribute(MARK)).toBe(false);
    const row = dom.window.document.createElement('div');
    row.className = '_dsh_sessionRow'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', 'false');
    row.innerHTML = '<span class="_dsh_title" id="new">B站 · 新对话</span>';
    dom.window.document.body.appendChild(row);
    await tick();
    expect(title('new').getAttribute(TEXT)).toBe('新对话');
    title('new').textContent = '用户重命名';
    await tick();
    expect(title('new').hasAttribute(MARK)).toBe(false);
  });

  it('does not hide text when image loading fails or when browser capabilities are missing', async () => {
    install(); images[0].dispatchEvent(new dom.window.Event('error')); await tick();
    expect(title().hasAttribute(MARK)).toBe(false);
    expect(title().textContent).toBe('B站 video: 视频标题');
    disposers.splice(0).forEach(dispose => dispose());
    Object.defineProperty(dom.window, 'CSS', { value: undefined });
    install();
    expect(dom.window.document.head.children).toHaveLength(0);
  });

  it('shares one observer/style installation, restores owned attributes and supports unload/reinstall', async () => {
    title().setAttribute(TEXT, 'existing attribute');
    const first = install(), second = install();
    expect(images).toHaveLength(1);
    expect(dom.window.document.head.children).toHaveLength(1);
    await load();
    first(); first();
    expect(title().hasAttribute(MARK)).toBe(true);
    second();
    expect(title().hasAttribute(MARK)).toBe(false);
    expect(title().getAttribute(TEXT)).toBe('existing attribute');
    expect(dom.window.document.head.children).toHaveLength(0);
    title().textContent = 'B站 · 卸载后'; await tick();
    expect(title().hasAttribute(MARK)).toBe(false);
    install(); await load();
    expect(title().getAttribute(TEXT)).toBe('卸载后');
  });

  it('keeps unsupported markup, unrelated prefixes and non-browser execution unchanged', async () => {
    title().parentElement!.className = 'future-row';
    install(); await load();
    expect(title().hasAttribute(MARK)).toBe(false);
    expect(bilibiliTitle('普通 B站 video: 内容')).toBeNull();
    expect(bilibiliTitle('B站 video: ')).toBeNull();
    expect(() => installSessionLogo(undefined)()).not.toThrow();
  });
});
