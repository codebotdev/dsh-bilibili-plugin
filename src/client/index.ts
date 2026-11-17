import { createElement } from 'react';
import { BilibiliSettings, type BilibiliSettingsProps } from './BilibiliSettings.js';
import { installStyles } from './styles.js';
import { installSessionLogo } from './session-logo.js';

export const inject = ['slots'];

export function apply(ctx: any): void {
  let navigation: { openSession(sessionId: string): void } | undefined;
  // Navigation is optional: its readiness must not gate settings or logo installation.
  ctx.inject(['uiWorkspace'], (scope: any) => {
    const service = scope.uiWorkspace;
    scope.effect(() => {
      navigation = service;
      return () => { if (navigation === service) navigation = undefined; };
    }, 'bilibili: session navigation');
  });
  ctx.effect(() => installStyles(), 'bilibili: styles');
  ctx.effect(() => installSessionLogo(), 'bilibili: session logo');
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'bilibili', order: 40, label: 'B站机器人' },
      ({ close }: { close: () => void }) => createElement<BilibiliSettingsProps>(BilibiliSettings, {
        onOpenSession: (sessionId: string) => {
          if (!navigation) throw new Error('对话导航服务未就绪');
          navigation.openSession(sessionId);
          close();
        },
      }),
    ),
  );
}
