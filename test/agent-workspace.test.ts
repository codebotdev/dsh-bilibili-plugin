import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PollerService } from '../src/poller-service.js';
import { BilibiliAgentBridge } from '../src/agent-bridge.js';

let dir: string;
let poller: PollerService;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-workspace-'));
  vi.stubEnv('BILIBILI_PROMPT_PATH', path.join(dir, 'persona.md'));
  vi.stubEnv('BILIBILI_POLLER_CONFIG_PATH', path.join(dir, 'config.json'));
  (PollerService as any).instance = null;
  poller = PollerService.getInstance({} as any);
  await poller.saveConfig({ targetWorkspacePath: dir, systemPrompt: 'persona one' });
});
afterEach(async () => { await poller.flushRecentMessages(); vi.restoreAllMocks(); vi.unstubAllEnvs(); (PollerService as any).instance = null; await fs.rm(dir, { recursive: true, force: true }); });

function harness(resumeCwd?: string) {
  const sections: any[] = [];
  const variables: any = {};
  const attachSession = vi.fn();
  const registry = { archivedSessionIds: [] as string[], create: vi.fn(async () => ({ attachSession })), list: () => [] };
  poller.setWorkspaceRegistry(registry);
  let bridge: BilibiliAgentBridge;
  const followup = vi.fn(() => {
    queueMicrotask(() => {
      const record = (bridge as any).active.values().next().value;
      record?.finish();
    });
  });
  const make = async (options: any, cwd: string) => {
    const agent: any = { session: { header: { cwd } }, followup };
    const agentCtx: any = { systemPrompt: { section: (s: any) => sections.push(s), variable: (n: string, f: any) => variables[n] = f } };
    Object.defineProperty(agentCtx, 'agent', {
      get: () => { throw new Error('cannot get property "agent" without inject'); },
    });
    agent.ctx = agentCtx;
    await options.setup(agent.ctx, agent);
    return { agent };
  };
  const agents = { get: vi.fn(), resume: vi.fn(async (o: any) => { if (!resumeCwd) throw new Error('not found'); return make(o, resumeCwd); }), create: vi.fn((o: any) => make(o, o.meta.cwd)) };
  const ctx: any = { on: vi.fn(), get: (n: string) => n === 'agents' ? agents : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } : undefined };
  bridge = new BilibiliAgentBridge(ctx);
  return { ctx, bridge, agents, sections, variables, followup, registry, attachSession };
}

it('rotates cached archived sessions once for concurrent callers and attaches the new id', async () => {
  const h = harness();
  const old = (await h.bridge.getOrCreate(message()))!;
  h.registry.archivedSessionIds.push(old.sessionId);
  h.attachSession.mockClear();
  const records = await Promise.all(Array.from({ length: 8 }, () => h.bridge.getOrCreate(message())));
  const next = records[0]!;
  expect(next.sessionId).not.toBe(old.sessionId);
  expect(records.every(record => record === next)).toBe(true);
  expect(h.agents.create).toHaveBeenCalledTimes(2);
  expect(h.bridge.findBySessionId(old.sessionId)).toBeUndefined();
  expect(h.attachSession.mock.calls.every(([id]) => id === next.sessionId)).toBe(true);
  expect(h.registry.archivedSessionIds).toEqual([old.sessionId]);
  expect(await h.bridge.getOrCreate(message())).toBe(next);
});

it('skips archived live agents and restores the replacement across bridge restarts', async () => {
  const h = harness();
  const old = (await h.bridge.getOrCreate(message()))!;
  h.registry.archivedSessionIds.push(old.sessionId);
  h.agents.get.mockImplementation(id => id === old.sessionId ? old.agent : undefined);
  const restarted = new BilibiliAgentBridge(h.ctx);
  h.agents.get.mockClear(); h.agents.resume.mockClear();
  const next = (await restarted.getOrCreate(message()))!;
  expect(next.sessionId).not.toBe(old.sessionId);
  expect(h.agents.get).not.toHaveBeenCalledWith(old.sessionId);
  expect(h.agents.resume.mock.calls.every(([o]) => o.resumeSessionId !== old.sessionId)).toBe(true);
  h.agents.resume.mockImplementation(async o => {
    expect(o.resumeSessionId).toBe(next.sessionId);
    return { agent: next.agent };
  });
  const again = new BilibiliAgentBridge(h.ctx);
  expect((await again.getOrCreate(message()))!.sessionId).toBe(next.sessionId);
  expect(h.agents.create).toHaveBeenCalledTimes(2);
  h.registry.archivedSessionIds.push(next.sessionId);
  h.agents.resume.mockRejectedValue(new Error('not found'));
  const third = (await again.getOrCreate(message()))!;
  expect([old.sessionId, next.sessionId]).not.toContain(third.sessionId);
});

it.each([undefined, {}, { archivedSessionIds: null }, { archivedSessionIds: [123] }])(
  'fails closed when archive status is missing or invalid: %j', async registry => {
    const h = harness();
    await h.bridge.getOrCreate(message());
    h.attachSession.mockClear();
    poller.setWorkspaceRegistry(registry);
    await expect(h.bridge.getOrCreate(message())).rejects.toThrow('归档状态不可用');
    expect(h.agents.create).toHaveBeenCalledTimes(1);
    expect(h.attachSession).not.toHaveBeenCalled();
  },
);

it('propagates archive read and replacement creation failures, then permits retry', async () => {
  const h = harness();
  const old = (await h.bridge.getOrCreate(message()))!;
  poller.setWorkspaceRegistry({ get archivedSessionIds() { throw new Error('storage unavailable'); } });
  await expect(h.bridge.getOrCreate(message())).rejects.toThrow('storage unavailable');
  poller.setWorkspaceRegistry(h.registry);
  h.registry.archivedSessionIds.push(old.sessionId);
  h.agents.create.mockRejectedValueOnce(new Error('create failed'));
  await expect(h.bridge.getOrCreate(message())).rejects.toThrow('create failed');
  expect(h.bridge.findBySessionId(old.sessionId)).toBeUndefined();
  expect((await h.bridge.getOrCreate(message()))!.sessionId).not.toBe(old.sessionId);
});

const message = () => ({ userId: '123', userName: 'test', message: 'hello', sourceType: 'dynamic', businessId: 11, subjectId: 100, reply: vi.fn() } as any);

it('uses canonical selected cwd, public registry and dynamic scoped persona, not user text', async () => {
  const h = harness();
  await h.bridge.handleInbound(message());
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalled());
  h.bridge.dispose();
  expect(h.agents.create.mock.calls[0][0].meta.cwd).toBe(await fs.realpath(dir));
  expect(h.registry.create).toHaveBeenCalledWith(await fs.realpath(dir));
  expect(h.attachSession).toHaveBeenCalled();
  expect(h.sections).toEqual([{ name: 'deployment:persona', order: 0, text: '{{bilibili_persona}}' }]);
  expect(h.variables.bilibili_persona()).toBe('persona one');
  await fs.writeFile(poller.getPromptFilePath(), 'persona two {{literal}}');
  expect(h.variables.bilibili_persona()).toBe('persona two {{literal}}');
  expect(JSON.stringify(h.followup.mock.calls[0])).not.toContain('persona one');
  expect(h.followup.mock.calls[0][0].id).toBeTruthy();
});
it('returns model unavailable when DSH default model service cannot provide a route', () => {
  const h = harness();
  h.ctx.get = (name: string) => name === 'agents' ? h.agents : undefined;
  expect(() => h.bridge.resolveModelRoute()).toThrow('模型不可用');
});

it('groups users and threads by content and separates business types', async () => {
  const h = harness();
  const a = await h.bridge.getOrCreate(message());
  const b = await h.bridge.getOrCreate({ ...message(), userId: '456', sourceId: 999 });
  expect(b!.sessionId).toBe(a!.sessionId);
  const c = await h.bridge.getOrCreate({ ...message(), subjectId: 101 });
  const d = await h.bridge.getOrCreate({ ...message(), businessId: 1 });
  expect(c!.sessionId).not.toBe(a!.sessionId);
  expect(d!.sessionId).not.toBe(a!.sessionId);
});
it('changes identity on workspace selection even for cached sender', async () => {
  const h = harness();
  const a = await h.bridge.getOrCreate(message());
  const second = path.join(dir, 'second'); await fs.mkdir(second);
  await poller.saveConfig({ targetWorkspacePath: second });
  const b = await h.bridge.getOrCreate(message());
  expect(a!.sessionId).not.toBe(b!.sessionId);
  expect(b!.agent.session.header.cwd).toBe(await fs.realpath(second));
});
it('persists independent model and switches cached sender without changing host default', async () => {
  const h = harness();
  const first = await h.bridge.getOrCreate(message());
  await poller.saveConfig({ modelSelection: { provider: 'separate', model: 'chosen' } });
  expect(h.bridge.resolveModelRoute()).toEqual({ provider: 'separate', model: 'chosen' });
  const next = await h.bridge.getOrCreate(message());
  expect(next!.sessionId).not.toBe(first!.sessionId);
  expect(h.agents.create.mock.calls.at(-1)![0].agentOptions).toEqual({ provider: 'separate', model: 'chosen' });
  expect(JSON.parse(await fs.readFile(poller.getConfigPath(), 'utf8')).modelSelection.model).toBe('chosen');
  await poller.saveConfig({ modelSelection: null });
  expect(h.bridge.resolveModelRoute()).toEqual({ provider: 'mock', model: 'mock' });
});
it('persists reasoningEffort in modelSelection, routes it to agentOptions, and isolates sessions', async () => {
  const h = harness();
  await poller.saveConfig({ modelSelection: { provider: 'separate', model: 'chosen', reasoningEffort: 'high' } });
  expect(h.bridge.resolveModelRoute()).toEqual({ provider: 'separate', model: 'chosen', reasoningEffort: 'high' });
  const a = await h.bridge.getOrCreate(message());
  expect(h.agents.create.mock.calls.at(-1)![0].agentOptions).toEqual({ provider: 'separate', model: 'chosen', reasoningEffort: 'high' });

  // Switching reasoningEffort generates a new sessionKey/sessionId
  await poller.saveConfig({ modelSelection: { provider: 'separate', model: 'chosen', reasoningEffort: 'low' } });
  expect(h.bridge.resolveModelRoute()).toEqual({ provider: 'separate', model: 'chosen', reasoningEffort: 'low' });
  const b = await h.bridge.getOrCreate(message());
  expect(b!.sessionId).not.toBe(a!.sessionId);
  expect(h.agents.create.mock.calls.at(-1)![0].agentOptions).toEqual({ provider: 'separate', model: 'chosen', reasoningEffort: 'low' });
});
it('rejects nonexistent explicit directory before saving without fallback', async () => {
  const previous = poller.getConfig().targetWorkspacePath;
  await expect(poller.saveConfig({ targetWorkspacePath: path.join(dir, 'missing') })).rejects.toThrow();
  expect(poller.getConfig().targetWorkspacePath).toBe(previous);
});
it('rejects file and relative workspace paths before saving', async () => {
  await expect(poller.saveConfig({ targetWorkspacePath: poller.getPromptFilePath() })).rejects.toThrow('不是目录');
  await expect(poller.saveConfig({ targetWorkspacePath: 'relative' })).rejects.toThrow('绝对路径');
});
it('rechecks an existing selected workspace at use time', async () => {
  const selected = path.join(dir, 'removed'); await fs.mkdir(selected);
  await poller.saveConfig({ targetWorkspacePath: selected });
  await fs.rmdir(selected);
  await expect(poller.resolveTargetWorkspaceCwd()).rejects.toThrow();
});
it('rejects resumed cwd mismatch before followup or workspace attachment', async () => {
  const other = path.join(dir, 'other'); await fs.mkdir(other);
  const h = harness(other);
  await expect(h.bridge.getOrCreate(message())).rejects.toThrow('不一致');
  expect(h.agents.create).not.toHaveBeenCalled();
  expect(h.followup).not.toHaveBeenCalled();
  expect(h.attachSession).not.toHaveBeenCalled();
});


function trackMessage(sourceId: string, userId = '123') {
  const context = { ...message(), sourceId, userId };
  poller.addRecentMessage({ id: `11_100_${sourceId}`, time: 1, sourceType: 'dynamic',
    user: { mid: userId, uname: 'offline' }, message: 'hello', status: 'processing' });
  return context;
}

it('records the actual session id and host title for queued messages sharing a session', async () => {
  const h = harness();
  const get = h.ctx.get;
  h.ctx.get = (name: string) => name === 'sessionTitle' ? { get: () => ({ title: '宿主对话标题' }) } : get(name);
  const contexts = [trackMessage('101'), trackMessage('102', '456')];
  await Promise.all(contexts.map(context => h.bridge.handleInbound(context)));
  const items = poller.getRecentMessages();
  expect(items).toHaveLength(2);
  expect(items[0].sessionId).toBe(items[1].sessionId);
  expect(items.every(item => item.sessionTitle === '宿主对话标题' && item.sessionId)).toBe(true);
  expect(h.agents.create).toHaveBeenCalledTimes(1);
  h.bridge.dispose();
});

it.each(['missing', 'failed', 'blank'] as const)('keeps the actual session id when title lookup is %s', async mode => {
  const h = harness();
  const get = h.ctx.get;
  h.ctx.get = (name: string) => name === 'sessionTitle' ? (mode === 'missing' ? undefined : {
    get: () => { if (mode === 'failed') throw new Error('title unavailable'); return { title: ' ' }; },
  }) : get(name);
  await h.bridge.handleInbound(trackMessage('103'));
  expect(poller.getRecentMessages()[0].sessionId).toBeTruthy();
  expect(poller.getRecentMessages()[0].sessionTitle).toBeUndefined();
  expect(h.followup).toHaveBeenCalledTimes(1);
  h.bridge.dispose();
});

it('retains each archived generation in its own record and restores the current id across bridge restart', async () => {
  const h = harness();
  await h.bridge.handleInbound(trackMessage('104'));
  const oldId = poller.getRecentMessages()[0].sessionId!;
  h.registry.archivedSessionIds.push(oldId);
  await h.bridge.handleInbound(trackMessage('105'));
  const current = poller.getRecentMessages()[0];
  expect(current.sessionId).not.toBe(oldId);
  expect(poller.getRecentMessages().find(item => item.id.endsWith('_104'))!.sessionId).toBe(oldId);
  const bound = h.bridge.findBySessionId(current.sessionId!)!;
  h.bridge.dispose();
  h.agents.resume.mockResolvedValue({ agent: bound.agent });
  const resumed = new BilibiliAgentBridge(h.ctx);
  h.followup.mockImplementation(() => {
    queueMicrotask(() => (resumed as any).active.values().next().value?.finish());
  });
  await resumed.handleInbound(trackMessage('106'));
  expect(poller.getRecentMessages()[0].sessionId).toBe(current.sessionId);
  resumed.dispose();
});

it('does not invent a conversation when agent binding fails', async () => {
  const h = harness();
  h.agents.create.mockRejectedValue(new Error('create failed'));
  await expect(h.bridge.handleInbound(trackMessage('107'))).rejects.toThrow('create failed');
  expect(poller.getRecentMessages()[0].sessionId).toBeUndefined();
  expect(poller.getRecentMessages()[0].sessionTitle).toBeUndefined();
  h.bridge.dispose();
});
