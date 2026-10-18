import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { installPluginEventCompatibility } from '../lib/yunzai/plugin-events.js';

function createLoader() {
  return {
    eventMap: {
      message: ['post_type', 'message_type', 'sub_type'],
      notice: ['post_type', 'notice_type', 'sub_type'],
      request: ['post_type', 'request_type', 'sub_type']
    },
    filtEvent(e, rule) {
      if (!rule.event) return false;
      const fields = this.eventMap[e.post_type] || [];
      return rule.event === rule.event.split('.').map((value, i) => value === '*' ? value : e[fields[i]]).join('.');
    }
  };
}

function assertNoticeMatching(loader) {
  const e = Object.freeze({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'invite' });
  const plugin = Object.freeze({ event: 'notice.group.increase' });
  assert.equal(loader.filtEvent(e, plugin), false);
  installPluginEventCompatibility(loader);
  assert.equal(loader.filtEvent(e, plugin), true);
  for (const event of ['notice', 'notice.*', 'notice.group_increase', 'notice.group_increase.invite', 'notice.group.increase.invite', 'notice.group.increase.*']) {
    assert.equal(loader.filtEvent(e, { event }), true, event);
  }
  for (const event of ['notice.group.increase.approve', 'notice.group.decrease', 'notice.group_increase.kick', 'message', 'notice.group.increase.invite.extra']) {
    assert.equal(loader.filtEvent(e, { event }), false, event);
  }
  const candidates = [{ plugin, rule: { event: 'notice.group.increase.invite' }, accept: () => 'handled' }];
  const selected = candidates.filter(item => loader.filtEvent(e, item.plugin));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].accept(), 'handled');
  assert.equal(loader.filtEvent(e, selected[0].rule), true);
  assert.equal(plugin.event, 'notice.group.increase');
  assert.equal(e.notice_type, 'group_increase');
}

test('notice aliases reach plugin and rule matching without changing event data', () => {
  assertNoticeMatching(createLoader());
});

test('other notification aliases keep subtype checks', () => {
  const loader = createLoader();
  installPluginEventCompatibility(loader);
  for (const [notice_type, sub_type] of [['group_decrease', 'kick'], ['group_ban', 'ban'], ['group_admin', 'set'], ['group_recall', ''], ['friend_recall', '']]) {
    const e = { post_type: 'notice', notice_type, sub_type };
    assert.equal(loader.filtEvent(e, { event: `notice.${notice_type.replaceAll('_', '.')}` }), true);
    assert.equal(loader.filtEvent(e, { event: `notice.${notice_type.replaceAll('_', '.')}.wrong` }), false);
  }
});

test('native message/request matching and rejection of missing events stay intact', () => {
  const loader = createLoader();
  installPluginEventCompatibility(loader);
  assert.equal(loader.filtEvent({ post_type: 'message', message_type: 'group', sub_type: 'normal' }, { event: 'message.group.normal' }), true);
  assert.equal(loader.filtEvent({ post_type: 'request', request_type: 'group', sub_type: 'invite' }, { event: 'request.group.invite' }), true);
  assert.equal(loader.filtEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' }, { event: 'notice.notify.poke' }), true);
  assert.equal(loader.filtEvent({ post_type: 'notice', notice_type: 'group_increase' }, {}), false);
});

test('installation is idempotent and changed plugin declarations refresh cached aliases', () => {
  const loader = createLoader();
  installPluginEventCompatibility(loader);
  const filter = loader.filtEvent;
  installPluginEventCompatibility(loader);
  assert.equal(loader.filtEvent, filter);
  const e = { post_type: 'notice', notice_type: 'group_increase', sub_type: 'invite' };
  const rule = { event: 'notice.group.increase.invite' };
  assert.equal(loader.filtEvent(e, rule), true);
  rule.event = 'notice.group.increase.approve';
  assert.equal(loader.filtEvent(e, rule), false);
  rule.event = 'notice.group.decrease.kick';
  assert.equal(loader.filtEvent({ ...e, notice_type: 'group_decrease', sub_type: 'kick' }, rule), true);
  assert.equal(loader.filtEvent(e, { event: 'notice.group.increase' }), true);
  installPluginEventCompatibility({});
});

const localLoader = new URL('../Yunzai/lib/plugins/loader.js', import.meta.url);
test('installed Yunzai loader accepts the same aliases', { skip: !existsSync(localLoader) }, () => {
  const source = readFileSync(localLoader, 'utf8');
  const start = source.indexOf('  filtEvent(e, v) {');
  const end = source.indexOf('\n  /** 判断权限 */', start);
  assert.ok(start >= 0 && end > start, 'locate installed loader matching method');
  const loader = createLoader();
  loader.eventCache = new WeakMap();
  loader.filtEvent = new Function(`return { ${source.slice(start, end)} };`)().filtEvent;
  assertNoticeMatching(loader);
});
