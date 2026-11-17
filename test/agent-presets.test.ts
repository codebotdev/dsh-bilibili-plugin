import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BilibiliAgentBridge, BiliAgentPresetError, type BilibiliAgentPresetRegistry } from '../src/agent-bridge.js';
import { PollerService } from '../src/poller-service.js';

let dir: string, poller: PollerService;
const bridges: BilibiliAgentBridge[] = [];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-presets-'));
  vi.stubEnv('BILIBILI_POLLER_CONFIG_PATH', path.join(dir, 'config.json'));
  vi.stubEnv('BILIBILI_PROMPT_PATH', path.join(dir, 'persona.md'));
  (PollerService as any).instance = null;
  poller = PollerService.getInstance({} as any);
  await poller.saveConfig({ targetWorkspacePath: dir, systemPrompt: 'B站人设', modelSelection: { provider: 'bili', model: 'chosen' } });
  poller.setWorkspaceRegistry({ archivedSessionIds: [], create: async () => ({ attachSession: vi.fn() }) });
});
afterEach(async () => {
  bridges.splice(0).forEach(bridge => bridge.dispose());
  await poller.flushRecentMessages();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  (PollerService as any).instance = null;
  await fs.rm(dir, { recursive: true, force: true });
});
const message = () => ({ userId: '42', userName: 'offline', sourceType: 'video', sourceId: '30',
  subjectId: '20', businessId: 1, videoBvid: 'BV17x411w7KC', actualVideoTitle: '离线视频',
  message: '创建定时任务', reply: vi.fn() } as any);

function fixture(recorded?: string, enablePresets = true) {
  const hostTools = ['bilibili_get_video_info', 'external_tool'];
  const definitions = new Map([['standard', ['schedule_create', 'schedule_list', 'bash']], ['minimal', []], ['custom', ['custom_tool']]]);
  const compositions = new WeakMap<object, string>();
  let defaultId = 'standard';
  const stored = recorded === undefined ? undefined : makeSession(recorded);
  const live = new Map<string, any>();
  const admissions: Array<{ tools: string[]; prompt: string[]; message: unknown }> = [];
  let activeBridge: BilibiliAgentBridge;
  const presets = {
    presetForSession: vi.fn((session: any) => session.events.findLast((event: any) => event.type === 'agent-preset/selected')?.data.agentPreset ?? session.header.agentPreset ?? null),
    resolve: vi.fn(async (id?: string) => {
      const selected = id ?? defaultId;
      if (!definitions.has(selected)) throw new Error('unknown preset');
      return { id: selected };
    }),
    mount: vi.fn(async (scope: any, id?: string) => {
      for (const name of definitions.get(id!)!) scope.visibleTools.add(name);
      scope.sections.set('harness:safety', '宿主安全约束');
      scope.sections.set('tool:schedule', '工具授权要求');
      scope.sections.set('deployment:persona', '预设默认人设');
      compositions.set(scope, id!);
      return { id: id! };
    }),
    composedPreset: vi.fn((scope: any) => compositions.get(scope)),
  } satisfies BilibiliAgentPresetRegistry;
  function makeSession(preset?: string) {
    const events: any[] = [{ type: 'user/message', data: { text: '保留的历史' } }];
    return { header: { cwd: dir, ...(preset ? { agentPreset: preset } : {}) }, events,
      append: vi.fn((type: string, data: unknown) => { events.push({ type, data }); }) };
  }
  const make = async (options: any, session = makeSession()) => {
    const sections = new Map<string, string>();
    const variables = new Map<string, () => string>();
    const scope: any = { visibleTools: new Set(hostTools), sections,
      systemPrompt: { section: ({ name, text }: any) => sections.set(name, text), variable: (name: string, read: () => string) => variables.set(name, read) } };
    const agent = { session, ctx: scope, followup: vi.fn((input: unknown) => {
      admissions.push({ tools: [...scope.visibleTools], prompt: [...sections.values()], message: input });
      queueMicrotask(() => (activeBridge as any).active.values().next().value?.finish());
    }) };
    await options.setup(scope, agent);
    live.set(options.sessionId ?? options.resumeSessionId, agent);
    return { agent };
  };
  const agents = { get: vi.fn((id: string) => live.get(id)), create: vi.fn((options: any) => make(options)),
    resume: vi.fn(async (options: any) => { if (!stored) throw new Error('not found'); return make(options, stored); }) };
  const ctx: any = { on: () => () => {}, get: (name: string) => name === 'agents' ? agents : undefined };
  const restartBridge = () => {
    activeBridge = new BilibiliAgentBridge(ctx); bridges.push(activeBridge);
    if (enablePresets) activeBridge.setAgentPresets(presets);
    return activeBridge;
  };
  return { bridge: restartBridge(), restartBridge, presets, agents, admissions, live, stored, hostTools,
    setDefault: (id: string) => { defaultId = id; } };
}

describe('B站 Agent preset composition, offline only', () => {
  it('mounts host tools before the first followup, then shadows persona without clearing other prompt sections', async () => {
    const h = fixture();
    await h.bridge.handleInbound(message());
    expect(h.admissions[0].tools).toEqual(expect.arrayContaining(['schedule_create', 'schedule_list', 'bash', 'external_tool', 'bilibili_get_video_info']));
    expect(h.admissions[0].prompt).toEqual(expect.arrayContaining(['宿主安全约束', '工具授权要求', '{{bilibili_persona}}']));
    expect(h.admissions[0].prompt).not.toContain('预设默认人设');
    const bound = (await h.bridge.getOrCreate(message()))!;
    expect(bound.agent.session.append).toHaveBeenCalledExactlyOnceWith('agent-preset/selected', { agentPreset: 'standard' });
    expect(h.agents.create.mock.calls[0][0].agentOptions).toEqual({ provider: 'bili', model: 'chosen' });
    expect(h.hostTools).toEqual(['bilibili_get_video_info', 'external_tool']);
  });

  it('mounts once for concurrent callers and does not change a live composition when the host default changes', async () => {
    const h = fixture();
    const records = await Promise.all(Array.from({ length: 8 }, () => h.bridge.getOrCreate(message())));
    expect(records.every(record => record === records[0])).toBe(true);
    expect(h.presets.mount).toHaveBeenCalledTimes(1);
    h.setDefault('minimal');
    expect(await h.bridge.getOrCreate(message())).toBe(records[0]);
    expect(h.presets.mount).toHaveBeenCalledTimes(1);
    expect(h.presets.resolve).toHaveBeenCalledTimes(1);
  });

  it('resumes the recorded preset even when the current default differs, retaining history and session identity', async () => {
    const h = fixture('custom');
    await h.bridge.handleInbound(message());
    expect(h.presets.resolve).toHaveBeenCalledWith('custom');
    expect(h.admissions[0].tools).toContain('custom_tool');
    expect(h.admissions[0].tools).not.toContain('schedule_create');
    expect(h.stored!.events[0]).toEqual({ type: 'user/message', data: { text: '保留的历史' } });
    expect(h.stored!.append).not.toHaveBeenCalled();
    const first = (await h.bridge.getOrCreate(message()))!;
    h.bridge.dispose(); h.live.clear();
    const restarted = h.restartBridge();
    expect((await restarted.getOrCreate(message()))!.sessionId).toBe(first.sessionId);
    expect(h.agents.create).not.toHaveBeenCalled();
    expect(h.presets.mount).toHaveBeenCalledTimes(2);
  });

  it('repairs legacy persisted sessions without a recorded preset during resume setup', async () => {
    const h = fixture('');
    const before = [...h.stored!.events];
    await h.bridge.handleInbound(message());
    expect(h.presets.resolve).toHaveBeenCalledWith(undefined);
    expect(h.admissions[0].tools).toContain('schedule_create');
    expect(h.stored!.events.slice(0, before.length)).toEqual(before);
    expect(h.stored!.append).toHaveBeenCalledExactlyOnceWith('agent-preset/selected', { agentPreset: 'standard' });
    expect(h.agents.create).not.toHaveBeenCalled();
  });

  it('respects a deliberately minimal default instead of forcing extra tools', async () => {
    const h = fixture(); h.setDefault('minimal');
    await h.bridge.handleInbound(message());
    expect(h.admissions[0].tools).not.toContain('schedule_create');
    expect(h.presets.mount).toHaveBeenCalledWith(expect.anything(), 'minimal');
  });

  it.each(['unknown', 'broken', 'mount-failed', 'wrong-binding'] as const)('stops on %s preset failure without creating over existing history', async mode => {
    const h = fixture(mode === 'unknown' ? 'unavailable' : 'custom');
    if (mode === 'broken') h.presets.resolve.mockResolvedValue({ id: 'custom', broken: 'failed to load' } as any);
    if (mode === 'mount-failed') h.presets.mount.mockRejectedValue(new Error('mount failed'));
    if (mode === 'wrong-binding') h.presets.mount.mockResolvedValue({ id: 'other' });
    await expect(h.bridge.handleInbound(message())).rejects.toBeInstanceOf(BiliAgentPresetError);
    expect(h.agents.create).not.toHaveBeenCalled();
    expect(h.admissions).toHaveLength(0);
    expect(h.stored!.append).not.toHaveBeenCalled();
  });

  it('allows retry after a transient mounting failure', async () => {
    const h = fixture('standard');
    h.presets.mount.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await expect(h.bridge.getOrCreate(message())).rejects.toBeInstanceOf(BiliAgentPresetError);
    await h.bridge.handleInbound(message());
    expect(h.admissions[0].tools).toContain('schedule_create');
    expect(h.agents.create).not.toHaveBeenCalled();
  });

  it('rejects cached/live uncomposed Agents and requires restart rather than hot-recomposing a nonblank conversation', async () => {
    const h = fixture(undefined, false);
    const old = (await h.bridge.getOrCreate(message()))!;
    h.bridge.setAgentPresets(h.presets);
    await expect(h.bridge.handleInbound(message())).rejects.toThrow('重启');
    h.bridge.dispose();
    const next = new BilibiliAgentBridge((h.bridge as any).ctx); bridges.push(next);
    next.setAgentPresets(h.presets);
    await expect(next.getOrCreate(message())).rejects.toThrow('重启');
    expect(h.presets.mount).not.toHaveBeenCalled();
    expect(h.admissions).toHaveLength(0);
    expect(h.live.values().next().value).toBe(old.agent);
  });

  it.each(['dispose', 'remove-service'] as const)('does not admit a model turn after %s during async mounting', async action => {
    const h = fixture('standard');
    const original = h.presets.mount.getMockImplementation()!;
    let release!: () => void;
    h.presets.mount.mockImplementation(async (...args) => { await new Promise<void>(done => { release = done; }); return original(...args); });
    const detach = h.bridge.setAgentPresets(h.presets);
    const pending = h.bridge.getOrCreate(message());
    const rejection = expect(pending).rejects.toBeInstanceOf(BiliAgentPresetError);
    await vi.waitFor(() => expect(h.presets.mount).toHaveBeenCalled());
    if (action === 'dispose') h.bridge.dispose(); else detach();
    release(); await rejection;
    expect(h.admissions).toHaveLength(0);
    expect(h.agents.create).not.toHaveBeenCalled();
  });

  it('does not let an old injection release detach a newer preset service binding', async () => {
    const h = fixture(undefined, false);
    const oldRelease = h.bridge.setAgentPresets(h.presets);
    h.bridge.setAgentPresets(h.presets);
    oldRelease(); oldRelease();
    await h.bridge.handleInbound(message());
    expect(h.admissions[0].tools).toContain('schedule_create');
  });

  it('keeps the original global-tool behavior on hosts without a preset registry', async () => {
    const h = fixture(undefined, false);
    await h.bridge.handleInbound(message());
    expect(h.presets.mount).not.toHaveBeenCalled();
    expect(h.admissions[0].tools).toEqual(h.hostTools);
    expect(h.admissions[0].prompt).toContain('{{bilibili_persona}}');
  });
});
