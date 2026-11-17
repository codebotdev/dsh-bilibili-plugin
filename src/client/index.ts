import { BilibiliSettings } from './BilibiliSettings.js';
import { installStyles } from './styles.js';
import { installSessionLogo } from './session-logo.js';

export const inject = ['slots'];

export function apply(ctx: any): void {
  ctx.effect(() => installStyles(), 'bilibili: styles');
  ctx.effect(() => installSessionLogo(), 'bilibili: session logo');
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'bilibili', order: 40, label: 'B站机器人' },
      BilibiliSettings,
    ),
  );
}
