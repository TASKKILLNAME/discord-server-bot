const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks } = require('./helpers/load-with-mocks');

function fixture() {
  const receipts = new Map();
  const locks = new Set();
  const messages = [];
  let attempts = 0;
  let failAt = 0;
  let failSave = false;
  let failRead = false;
  const service = loadWithMocks('../../src/services/patchDelivery', {
    '../db': { pool: { async connect() { return {
      release() {},
      async query(sql, p) {
        if (sql.includes('pg_try_advisory_lock')) {
          const locked = !locks.has(p[0]);
          if (locked) locks.add(p[0]);
          return { rows: [{ locked }] };
        }
        if (sql.includes('pg_advisory_unlock')) { locks.delete(p[0]); return { rows: [] }; }
        const key = p.slice(0, 3).join('|');
        if (sql.startsWith('SELECT *')) {
          if (failRead) throw new Error('DB unavailable');
          return { rows: receipts.has(key) ? [structuredClone(receipts.get(key))] : [] };
        }
        if (sql.includes('INSERT INTO patch_deliveries')) {
          const row = { payloads: JSON.parse(p[3]), next_index: 0, created_at: new Date(), sent_at: p[4] ? new Date() : null };
          receipts.set(key, row);
          return { rows: [structuredClone(row)] };
        }
        if (sql.includes('SET next_index')) {
          if (failSave) { failSave = false; throw new Error('DB write failed after send'); }
          receipts.get(key).next_index = p[3];
        } else if (sql.includes('SET sent_at')) receipts.get(key).sent_at = new Date();
        else throw new Error(sql);
        return { rows: [] };
      },
    }; } } },
  });
  const channel = {
    id: 'channel', client: { user: { id: 'bot' } },
    messages: { async fetch() {
      const map = new Map(messages.map((message, i) => [String(i), message]));
      map.last = () => messages.at(-1);
      return map;
    } },
    async send(payload) {
      if (++attempts === failAt) throw new Error('Discord send failed');
      messages.push({ id: String(messages.length + 1), author: { id: 'bot' }, content: payload.content || '',
        createdTimestamp: Date.now(), embeds: (payload.embeds || []).map(data => ({ toJSON: () => data })) });
    },
  };
  const build = async () => [{ content: 'alert' }, { embeds: [{ title: 'summary', fields: [{ name: 'buff', value: 'short' }] }] }, { content: '📎 **원문 보기:** https://example.com/patch' }];
  return { service, channel, messages, receipts, build,
    setFailAt: value => failAt = value,
    setFailSave: () => failSave = true,
    setFailRead: () => failRead = true,
    run: (url = 'https://example.com/patch') => service.deliverPatch('lol', channel, url, build),
  };
}

test('전송 완료 후에만 기록하고 반복/URL trailing slash 차이는 재전송하지 않는다', async () => {
  const f = fixture();
  await f.run(); await f.run('https://example.com/patch/');
  assert.equal(f.messages.length, 3);
  assert.ok([...f.receipts.values()][0].sent_at);
});
test('중간 Discord 실패 후 성공한 메시지는 건너뛰고 나머지 전송을 재개한다', async () => {
  const f = fixture(); f.setFailAt(2);
  await assert.rejects(f.run(), /Discord/);
  assert.equal([...f.receipts.values()][0].sent_at, null);
  await f.run();
  assert.equal(f.messages.length, 3);
  assert.equal(f.messages.filter(m => m.content === 'alert').length, 1);
});
test('Discord 성공 후 DB 저장 실패 시 게시 이력으로 복구하여 중복 전송하지 않는다', async () => {
  const f = fixture(); f.setFailSave();
  await assert.rejects(f.run(), /DB write/);
  await f.run();
  assert.equal(f.messages.length, 3);
});
test('DB 조회 오류에서는 아무것도 전송하지 않는다', async () => {
  const f = fixture(); f.setFailRead();
  await assert.rejects(f.run(), /DB unavailable/);
  assert.equal(f.messages.length, 0);
});
test('동시 요청은 DB advisory lock으로 한 번만 전송한다', async () => {
  const f = fixture(); await Promise.all([f.run(), f.run()]);
  assert.equal(f.messages.length, 3);
});
test('기존 bot 원문 링크가 있으면 legacy 상태와 무관하게 재게시하지 않는다', async () => {
  const f = fixture();
  await f.channel.send({ content: '📎 **원문 보기:** https://example.com/patch/' });
  await f.run();
  assert.equal(f.messages.length, 1);
});
test('다른 사용자가 올린 같은 URL은 bot 전송 기록으로 취급하지 않는다', async () => {
  const f = fixture();
  await f.channel.send({ content: '📎 **원문 보기:** https://example.com/patch' });
  f.messages[0].author.id = 'human';
  await f.run();
  assert.equal(f.messages.length, 4);
});
test('한 채널 실패 시 완료된 다른 채널은 재전송하지 않는다', async () => {
  const f = fixture();
  await f.run();
  const other = { ...f.channel, id: 'other', messages: { async fetch() { return new Map(); } },
    async send() { throw new Error('other channel failed'); } };
  await assert.rejects(f.service.deliverPatch('lol', other, 'https://example.com/patch', f.build));
  await f.run();
  assert.equal(f.messages.length, 3);
});
test('Discord 게시 이력을 읽을 수 없으면 추측해서 전송하지 않는다', async () => {
  const f = fixture();
  f.channel.messages.fetch = async () => { throw new Error('Missing Access'); };
  await assert.rejects(f.run(), /Missing Access/);
  assert.equal(f.messages.length, 0);
});
test('Discord가 원문 링크에 자동 미리보기를 붙여도 마지막 메시지를 중복 전송하지 않는다', async () => {
  const f = fixture(); await f.run();
  const receipt = [...f.receipts.values()][0];
  receipt.sent_at = null;
  receipt.next_index = 2;
  f.messages[2].embeds = [{ toJSON: () => ({ title: 'automatic link preview' }) }];
  await f.run();
  assert.equal(f.messages.length, 3);
});
