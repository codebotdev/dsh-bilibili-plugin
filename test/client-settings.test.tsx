import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BilibiliSettings } from '../src/client/BilibiliSettings.js';
import { biliStore } from '../src/client/store.js';
import { apply, inject as clientDependencies } from '../src/client/index.js';
import type { BiliProcessedMessageItem } from '../src/types.js';

const account = { mid: 42, uname: '离线用户', face: '', level: 6, coins: 0, vipType: 0 };
const config = {
  enableReply: true, enableAt: false, autoLikeOnReply: true, enableWhitelist: false,
  whitelist: [], pollIntervalSeconds: 10, imageDownloadTimeoutMs: 10000,
  imageDownloadMaxBytes: 8388608, imageDownloadMaxCount: 5, systemPrompt: '测试人设',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let view: ReactTestRenderer | undefined;
const fetchMock = vi.fn<typeof fetch>();
let requests: AbortSignal[];
let failConfig = false;
let loggedIn = true;
let saved = { ...config };
let recentMessages: BiliProcessedMessageItem[] = [];
const record: BiliProcessedMessageItem = {
  id: 'offline-message', time: 1, sourceType: 'video',
  user: { mid: '42', uname: '离线用户' }, message: '独立页签中的评论', status: 'replied', replyText: '离线回复',
};
const render = async () => { await act(async () => { view = create(<BilibiliSettings />); }); };
const text = () => JSON.stringify(view!.toJSON());
const button = (label: string) => view!.root.findAllByType('button').find(node => node.findAllByType('span').some(span => span.children.join('') === label) || node.children.join('') === label)!;

beforeEach(() => {
  requests = [];
  recentMessages = [];
  failConfig = false;
  loggedIn = true;
  saved = { ...config };
  biliStore.close();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.signal && !String(input).endsWith('/auth/status')) requests.push(init.signal);
    const path = String(input).replace('/api/bilibili', '');
    if (path === '/auth/status') return json(loggedIn
      ? { hasVault: true, isUnlocked: true, user: account, accountSummary: account }
      : { hasVault: false, isUnlocked: false, user: null, accountSummary: null });
    if (path === '/models' || path === '/workspaces') return json([]);
    if (path === '/poller/config') {
      if (failConfig) return json({ error: '配置读取失败' }, 500);
      if (init?.method === 'POST') {
        saved = { ...saved, ...JSON.parse(String(init.body)) };
        return json({ success: true, config: saved });
      }
      return json(saved);
    }
    if (path === '/poller/recent-messages') return json({ success: true, list: recentMessages });
    if (path === '/poller/recent-messages/clear') { recentMessages = []; return json({ success: true }); }
    if (path === '/auth/qrcode/generate') return json({ error: '二维码服务不可用' }, 502);
    throw new Error(`未模拟的请求: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
  vi.useRealTimers();
});

describe('B站设置页迁移', () => {
  it('registers one settings section and waits for the host slot before registering', () => {
    const register = vi.fn(() => () => {});
    let ready!: () => unknown;
    const inject = vi.fn((_name, callback) => { ready = callback; });
    // Do not execute the style effect; no DOM or host startup is needed.
    apply({ slots: { inject, register }, inject: vi.fn(), effect: vi.fn() });
    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function));
    expect(register).not.toHaveBeenCalled();
    ready();
    expect(register).toHaveBeenCalledExactlyOnceWith(
      { name: 'settings.section', id: 'bilibili', order: 40, label: 'B站机器人' }, expect.any(Function),
    );
  });

  it('shows account, settings and history inline, saves changes and restores them after remount', async () => {
    await render();
    expect(text()).toContain('离线用户');
    expect(text()).toContain('Lv.');
    expect(text()).toContain('默认模型');
    expect(text()).not.toContain('dsh-bili-pill');
    const toggle = view!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!;
    await act(async () => toggle.props.onChange());
    expect(saved.enableReply).toBe(false);
    await act(async () => button('消息记录').props.onClick());
    expect(text()).toContain('最近处理的消息');
    await act(async () => button('配置').props.onClick());
    await act(async () => button('管理账号').props.onClick());
    expect(text()).toContain('B站账号管理');
    await act(async () => view!.unmount());
    expect(biliStore.getState().isOpen).toBe(false);
    expect(requests.every(signal => signal.aborted)).toBe(true);
    await render();
    expect(view!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.checked).toBe(false);
    expect(text()).not.toContain('B站账号管理');
  });

  it('switches separate accessible panels and preserves the unsaved persona draft', async () => {
    recentMessages = [record];
    await render();
    const panels = () => view!.root.findAll(node => node.props.role === 'tabpanel');
    expect(view!.root.findAll(node => node.props.role === 'tablist')).toHaveLength(1);
    expect(button('配置').props['aria-selected']).toBe(true);
    expect(panels().map(panel => panel.props.hidden)).toEqual([false, true]);
    expect(button('消息历史')).toBeUndefined();
    await act(async () => button('自定义人设').props.onClick());
    await act(async () => view!.root.findByType('textarea').props.onChange({ target: { value: '尚未保存的人设' } }));
    await act(async () => button('消息记录').props.onClick());
    expect(panels().map(panel => panel.props.hidden)).toEqual([true, false]);
    expect(button('消息记录').props['aria-selected']).toBe(true);
    expect(panels()[1].props['aria-labelledby']).toBe(button('消息记录').props.id);
    expect(button('消息记录').props['aria-controls']).toBe(panels()[1].props.id);
    expect(text()).toContain(record.message);
    expect(button('刷新')).toBeDefined();
    expect(button('清空')).toBeDefined();
    await act(async () => button('配置').props.onClick());
    expect(view!.root.findByType('textarea').props.value).toBe('尚未保存的人设');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('polls only the messages tab and cancels reads/timers when switching away or unmounting', async () => {
    vi.useFakeTimers();
    const reads = () => fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/poller/recent-messages'));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads()).toHaveLength(0);
    await act(async () => button('消息记录').props.onClick());
    expect(reads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(reads()).toHaveLength(2);
    const signal = reads().at(-1)![1]!.signal!;
    await act(async () => button('配置').props.onClick());
    expect(signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads()).toHaveLength(2);
    await act(async () => button('消息记录').props.onClick());
    expect(reads()).toHaveLength(3);
    await act(async () => view!.unmount());
    view = undefined;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads()).toHaveLength(3);
  });

  it('shows loading/error/empty records independently from configuration and allows refresh retry', async () => {
    await render();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    await act(async () => button('消息记录').props.onClick());
    expect(text()).toContain('正在加载处理记录');
    await act(async () => resolve(json({ error: '消息读取失败' }, 500)));
    expect(text()).toContain('消息读取失败');
    expect(button('消息记录').props['aria-selected']).toBe(true);
    await act(async () => button('刷新').props.onClick());
    expect(text()).not.toContain('消息读取失败');
    expect(text()).toContain('暂无处理记录');
  });

  it('ignores a pending history response after switching away and reopening the messages tab', async () => {
    await render();
    let resolve!: (value: Response) => void;
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_input, init) => {
      signal = init!.signal!;
      return new Promise<Response>(done => { resolve = done; });
    });
    await act(async () => button('消息记录').props.onClick());
    await act(async () => button('配置').props.onClick());
    expect(signal.aborted).toBe(true);
    recentMessages = [{ ...record, id: 'fresh', message: '重新进入后取得的记录' }];
    await act(async () => button('消息记录').props.onClick());
    await act(async () => resolve(json({ success: true, list: [record] })));
    expect(text()).toContain('重新进入后取得的记录');
    expect(text()).not.toContain(record.message);
  });

  it('preserves records on clear failure and prevents a stale refresh from undoing a successful clear', async () => {
    recentMessages = [record];
    await render();
    await act(async () => button('消息记录').props.onClick());
    fetchMock.mockImplementationOnce(async () => json({ error: '清空失败' }, 500));
    await act(async () => button('清空').props.onClick());
    expect(text()).toContain('清空失败');
    expect(text()).toContain(record.message);
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    await act(async () => { void button('刷新').props.onClick(); });
    await act(async () => button('清空').props.onClick());
    await act(async () => resolve(json({ success: true, list: [record] })));
    expect(text()).not.toContain(record.message);
    expect(text()).toContain('暂无处理记录');
    expect(button('消息记录').props['aria-selected']).toBe(true);
  });

  it('supports keyboard tab navigation and closes account actions when entering records', async () => {
    await render();
    await act(async () => button('管理账号').props.onClick());
    expect(biliStore.getState().isOpen).toBe(true);
    const focus = vi.fn();
    const getElementById = vi.fn(() => ({ focus }));
    const event = (key: string) => ({ key, preventDefault: vi.fn(), currentTarget: { ownerDocument: { getElementById } } });
    await act(async () => button('配置').props.onKeyDown(event('ArrowRight')));
    expect(button('消息记录').props['aria-selected']).toBe(true);
    expect(biliStore.getState().isOpen).toBe(false);
    expect(getElementById).toHaveBeenLastCalledWith(button('消息记录').props.id);
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => button('消息记录').props.onKeyDown(event('Home')));
    expect(button('配置').props['aria-selected']).toBe(true);
    expect(button('消息记录').props.tabIndex).toBe(-1);
  });

  it('shows conversation metadata only when there is a title or id, with honest title-only/id-only fallbacks', async () => {
    recentMessages = [
      { ...record, id: 'both', sessionId: 'session-both', sessionTitle: '真实对话标题' },
      { ...record, id: 'title', sessionTitle: '只有标题' },
      { ...record, id: 'id', sessionId: 'session-id-only' },
      { ...record, id: 'legacy' },
      { ...record, id: 'blank', sessionId: ' ', sessionTitle: ' ' },
    ];
    const open = vi.fn();
    await act(async () => { view = create(<BilibiliSettings onOpenSession={open} />); });
    await act(async () => button('消息记录').props.onClick());
    const rows = view!.root.findAll(node => node.props.className?.split(' ').includes('dsh-bili-recent-conversation'));
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.findAllByType('span')[0].children.join('') === '会话')).toBe(true);
    expect(rows[1].findAllByType('button')).toHaveLength(0);
    expect(rows[1].findAllByType('span').at(-1)!.children).toEqual(['只有标题']);
    await act(async () => button('真实对话标题').props.onClick());
    expect(open).toHaveBeenLastCalledWith('session-both');
    await act(async () => button('打开会话').props.onClick());
    expect(open).toHaveBeenLastCalledWith('session-id-only');
  });

  it('opens the actual session through the host navigation service and then closes settings', async () => {
    recentMessages = [{ ...record, sessionId: 'durable-session', sessionTitle: 'B站会话' }];
    const openSession = vi.fn(), close = vi.fn();
    let Component!: React.ComponentType<{ close: () => void }>;
    apply({ inject: (_deps: string[], ready: (scope: unknown) => void) => ready({ uiWorkspace: { openSession }, effect: (effect: () => unknown) => effect() }), effect: vi.fn(), slots: {
      inject: (_name: string, ready: () => void) => ready(),
      register: (_options: unknown, component: typeof Component) => { Component = component; return () => {}; },
    } });
    await act(async () => { view = create(<Component close={close} />); });
    await act(async () => button('消息记录').props.onClick());
    await act(async () => button('B站会话').props.onClick());
    expect(openSession).toHaveBeenCalledExactlyOnceWith('durable-session');
    expect(close).toHaveBeenCalledTimes(1);
    expect(openSession.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it('keeps settings and logo effects registered before navigation is ready, and releases navigation independently', async () => {
    recentMessages = [{ ...record, sessionId: 'session-late', sessionTitle: '等待导航的会话' }];
    const openSession = vi.fn(), close = vi.fn(), effect = vi.fn();
    let Component!: React.ComponentType<{ close: () => void }>;
    let ready!: (scope: unknown) => void;
    let release!: () => void;
    apply({ effect, inject: (_deps: string[], callback: typeof ready) => { ready = callback; }, slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (_options: unknown, component: typeof Component) => { Component = component; return () => {}; },
    } });
    expect(clientDependencies).toEqual(['slots']);
    expect(effect.mock.calls.map(([, label]) => label)).toEqual(['bilibili: styles', 'bilibili: session logo']);
    await act(async () => { view = create(<Component close={close} />); });
    await act(async () => button('消息记录').props.onClick());
    await act(async () => button('等待导航的会话').props.onClick());
    expect(close).not.toHaveBeenCalled();
    expect(text()).toContain('打开会话失败');
    ready({ uiWorkspace: { openSession }, effect: (callback: () => () => void) => { release = callback(); } });
    await act(async () => button('等待导航的会话').props.onClick());
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-late');
    expect(close).toHaveBeenCalledTimes(1);
    release();
    await act(async () => button('等待导航的会话').props.onClick());
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps records visible if opening fails, and disables links when navigation is absent', async () => {
    recentMessages = [{ ...record, sessionId: 'missing-session', sessionTitle: '失效会话' }];
    await render();
    await act(async () => button('消息记录').props.onClick());
    expect(button('失效会话').props.disabled).toBe(true);
    await act(async () => view!.unmount());
    await act(async () => { view = create(<BilibiliSettings onOpenSession={() => { throw new Error('unavailable'); }} />); });
    await act(async () => button('消息记录').props.onClick());
    await act(async () => button('失效会话').props.onClick());
    expect(text()).toContain('打开会话失败');
    expect(text()).toContain(record.message);
    expect(button('消息记录').props['aria-selected']).toBe(true);
  });

  it('restores automatic binding as the default and persists explicit workspace selection', async () => {
    await render();
    const workspace = () => view!.root.findAllByType('select').find(node =>
      node.findAllByType('option').some(option => option.children.join('') === '自动绑定当前活跃工作区'))!;
    expect(workspace().findAllByType('option')[0].children.join('')).toBe('自动绑定当前活跃工作区');
    expect(workspace().props.value).toBe('');
    expect(text()).not.toContain('未分组');
    await act(async () => workspace().props.onChange({ target: { value: '/mock/workspace' } }));
    expect(saved).toMatchObject({ targetWorkspacePath: '/mock/workspace' });
    await act(async () => view!.unmount());
    await render();
    expect(workspace().props.value).toBe('/mock/workspace');
    await act(async () => workspace().props.onChange({ target: { value: '' } }));
    expect(saved).toMatchObject({ targetWorkspacePath: '' });
    expect(workspace().props.value).toBe('');
  });

  it('allows account login with no account and reports QR request failure inside settings', async () => {
    loggedIn = false;
    await render();
    expect(text()).toContain('尚未登录');
    await act(async () => button('扫码登录').props.onClick());
    expect(text()).toContain('二维码服务不可用');
    expect(text()).toContain('B站账号管理');
  });

  it('keeps the previous value when saving fails and allows a later retry', async () => {
    await render();
    const toggle = () => view!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!;
    fetchMock.mockImplementationOnce(async () => json({ error: '保存失败' }, 500));
    await act(async () => toggle().props.onChange());
    expect(text()).toContain('保存失败');
    expect(toggle().props.checked).toBe(true);
    await act(async () => toggle().props.onChange());
    expect(toggle().props.checked).toBe(false);
    expect(text()).toContain('配置已保存');
  });

  it('cancels pending page reads when leaving settings and ignores late responses after remount', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const transport = fetchMock.getMockImplementation()!;
    let oldSignal!: AbortSignal;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/poller/config')) {
        oldSignal = init!.signal!;
        return pending; // Simulate a transport that ignores cancellation.
      }
      return transport(input, init);
    });
    await render();
    expect(text()).toContain('正在加载配置');
    await act(async () => view!.unmount());
    expect(oldSignal.aborted).toBe(true);
    fetchMock.mockImplementation(transport);
    saved.enableReply = false;
    await render();
    await act(async () => resolve(json(config)));
    expect(view!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.checked).toBe(false);
  });

  it('shows failed configuration loading and supports retry without losing the account entry', async () => {
    failConfig = true;
    await render();
    expect(text()).toContain('配置读取失败');
    expect(button('管理账号')).toBeDefined();
    failConfig = false;
    await act(async () => button('重试加载配置').props.onClick());
    expect(text()).toContain('默认模型');
    expect(text()).not.toContain('配置读取失败');
  });
});
