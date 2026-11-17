import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BilibiliSettings } from '../src/client/BilibiliSettings.js';
import { biliStore } from '../src/client/store.js';
import { apply } from '../src/client/index.js';

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
const render = async () => { await act(async () => { view = create(<BilibiliSettings />); }); };
const text = () => JSON.stringify(view!.toJSON());
const button = (label: string) => view!.root.findAllByType('button').find(node => node.findAllByType('span').some(span => span.children.join('') === label) || node.children.join('') === label)!;

beforeEach(() => {
  requests = [];
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
    if (path === '/poller/recent-messages') return json({ success: true, list: [] });
    if (path === '/auth/qrcode/generate') return json({ error: '二维码服务不可用' }, 502);
    throw new Error(`未模拟的请求: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
});

describe('B站设置页迁移', () => {
  it('registers one settings section and waits for the host slot before registering', () => {
    const register = vi.fn(() => () => {});
    let ready!: () => unknown;
    const inject = vi.fn((_name, callback) => { ready = callback; });
    // Do not execute the style effect; no DOM or host startup is needed.
    apply({ slots: { inject, register }, effect: vi.fn() });
    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function));
    expect(register).not.toHaveBeenCalled();
    ready();
    expect(register).toHaveBeenCalledExactlyOnceWith(
      { name: 'settings.section', id: 'bilibili', order: 40, label: 'B站机器人' }, BilibiliSettings,
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
    await act(async () => button('消息历史').props.onClick());
    expect(text()).toContain('最近处理的消息');
    await act(async () => button('管理账号').props.onClick());
    expect(text()).toContain('B站账号管理');
    await act(async () => view!.unmount());
    expect(biliStore.getState().isOpen).toBe(false);
    expect(requests.every(signal => signal.aborted)).toBe(true);
    await render();
    expect(view!.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.checked).toBe(false);
    expect(text()).not.toContain('B站账号管理');
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
