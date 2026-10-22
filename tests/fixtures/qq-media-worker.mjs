import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Format } from '../../node_modules/alemonjs/lib/application/format/message-format.js';

const ResultCode = { Ok: 2000 };

const events = [];
const responses = [];
const calls = [];
const handlers = {};
let failAt = -1;
let inFlight = 0;
const send = async (route, value) => {
  assert.equal(inFlight++, 0, 'split messages must be sent sequentially');
  calls.push({ route, value });
  await new Promise(resolve => setImmediate(resolve));
  inFlight--;
  return [{ code: calls.length === failAt ? 4000 : ResultCode.Ok, message: 'fixture', data: { id: String(calls.length) } }];
};
const manager = { isReady: true, send: message => events.push(message), sendToWorker: message => responses.push(message) };
for (const name of ['Reply', 'Done', 'ApiRequest', 'WorkerExit', 'Ready']) {
  manager[`on${name}`] = callback => { handlers[name] = callback; };
}
mock.module(new URL('../../lib/yunzai/manager.js', import.meta.url).href, { namedExports: { manager } });
mock.module(new URL('../../lib/path.js', import.meta.url).href, { namedExports: { getYunzaiEventConcurrency: () => 1 } });
const noop = () => {};
mock.module('alemonjs', {
  namedExports: {
    Format, ResultCode, logger: { info: noop, debug: noop, warn: noop, error: noop },
    useMessage: () => [{ send: ({ format }) => send('reply', format.value) }],
    sendToChannel: (id, value) => send(`channel:${id}`, value),
    sendToUser: (id, value) => send(`user:${id}`, value),
    useClient: noop, useGuild: noop, useMe: noop, useMember: noop, useRequest: noop, useUser: noop, useMedia: () => [{ list: async () => ({ code: 4000 }) }], MessageDirect: { create: () => ({ sendToTarget: ({ target, format }) => send(`${target.scope === 'c2c' ? 'user' : 'channel'}:${target.targetId}`, format.value) }) }, getConfigValue: () => ({})
  }
});
mock.module('@alemonjs/onebot', { namedExports: { API: {} } });
mock.timers.enable({ apis: ['setTimeout'] });
const { default: bridge } = await import('../../lib/yunzai/bridge.js');
const event = platform => ({
  name: 'message.create', Platform: platform, BotId: 'bot', GuildId: 'group', ChannelId: 'group',
  UserId: 'user', MessageId: 'message', MessageText: 'hello'
});
bridge(event('qq-bot'), noop);
const msgId = events.at(-1).id;
const image = { type: 'image', data: 'base64://aGVsbG8=' };
const button = { type: 'button', data: '', buttonData: [[{ title: '更新面板', data: '#更新面板' }]] };
const md = { type: 'markdown', data: '**面板**\n![远程图片](https://example.com/panel.png)' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const waitResponse = async count => {
  for (let i = 0; responses.length === count && i < 30; i++) await flush();
  assert.equal(responses.length, count + 1);
  return responses.at(-1);
};
const reply = async contents => {
  calls.length = 0;
  const count = responses.length;
  handlers.Reply({ id: msgId, replyId: `reply-${count}`, contents });
  return await waitResponse(count);
};
const types = () => calls.map(call => call.value.map(item => item.type));

assert.equal((await reply([image, md, button])).ok, true);
assert.deepEqual(types(), [['Image'], ['MarkdownOriginal', 'BT.group']]);
assert.equal(calls[1].value[0].value, md.data);
assert.equal(calls[1].value[1].value.length, 1);

await reply([image, button]);
assert.deepEqual(types(), [['Image'], ['MarkdownOriginal', 'BT.group']]);
assert.ok(calls[1].value[0].value.trim());
await reply([image, { type: 'text', data: '面板操作' }, button]);
assert.equal(calls[1].value[0].value, '面板操作');
await reply([image, { type: 'image', data: 'https://example.com/panel.png' }, md, button]);
assert.deepEqual(types(), [['Image'], ['Image'], ['MarkdownOriginal', 'BT.group']]);
await reply([image, image]);
assert.deepEqual(types(), [['Image'], ['Image']]);
await reply([image, { type: 'quote', data: '123' }]);
assert.deepEqual(types(), [['Image']]);
await reply([md, button]);
assert.deepEqual(types(), [['MarkdownOriginal', 'BT.group']]);
await reply([{ type: 'forward', data: 'summary', fallback: [image, { type: 'forward', data: '', fallback: [md, button] }] }]);
assert.deepEqual(types(), [['Image'], ['MarkdownOriginal', 'BT.group']]);

for (const action of ['sendGroupMsg', 'sendPrivateMsg']) {
  calls.length = 0;
  const count = responses.length;
  handlers.ApiRequest({ reqId: action, msgId, action, params: { group_id: 'group', user_id: 'user', contents: [image, md, button] } });
  assert.equal((await waitResponse(count)).ok, true);
  assert.deepEqual(types(), [['Image'], ['MarkdownOriginal', 'BT.group']]);
  assert.ok(calls.every(call => call.route === (action === 'sendGroupMsg' ? 'channel:group' : 'user:user')));
}

failAt = 1;
assert.equal((await reply([image, image, md, button])).ok, false);
assert.equal(calls.length, 1);
failAt = 2;
assert.equal((await reply([image, md, button])).ok, false);
assert.equal(calls.length, 2);
failAt = -1;

handlers.Done({ id: msgId, replied: true });
bridge(event('other-platform'), noop);
calls.length = 0;
const count = responses.length;
handlers.Reply({ id: events.at(-1).id, replyId: 'other', contents: [image, md, button] });
assert.equal((await waitResponse(count)).ok, true);
assert.equal(calls.length, 1);
assert.deepEqual(types(), [['Image', 'Text', 'Text']]);
handlers.WorkerExit();
mock.timers.reset();
console.log('QQ media split passed');
