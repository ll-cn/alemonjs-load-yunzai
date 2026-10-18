const compatibleFilters = new WeakSet<object>();

/** 兼容 icqq 点号通知名与 OneBot 下划线通知名，不改写原始事件或插件配置。 */
export function installPluginEventCompatibility(loader: any): void {
  const original = loader?.filtEvent;

  if (typeof original !== 'function' || compatibleFilters.has(original)) {
    return;
  }
  const aliases = new WeakMap<object, { source: string; noticeType: string; rule: { event: string } }>();
  const filter = function (this: any, e: any, rule: any): boolean {
    if (original.call(this, e, rule)) {
      return true;
    }
    if (e?.post_type !== 'notice' || typeof e.notice_type !== 'string' || typeof rule?.event !== 'string') {
      return false;
    }
    const prefix = `notice.${e.notice_type.replace(/_/g, '.')}`;

    if (!e.notice_type.includes('_') || (rule.event !== prefix && !rule.event.startsWith(`${prefix}.`))) {
      return false;
    }
    let cached = aliases.get(rule);

    if (!cached || cached.source !== rule.event || cached.noticeType !== e.notice_type) {
      cached = {
        source: rule.event,
        noticeType: e.notice_type,
        rule: { event: `notice.${e.notice_type}${rule.event.slice(prefix.length)}` }
      };
      aliases.set(rule, cached);
    }

    // 仍由原加载器判断 subtype、通配符等条件；插件级和 rule 级共用此入口。
    return original.call(this, e, cached.rule);
  };

  compatibleFilters.add(filter);
  loader.filtEvent = filter;
}
