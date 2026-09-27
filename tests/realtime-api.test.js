'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWithMocks } = require('./helpers/load-with-mocks');

test('실제 Riot API 계층은 rank 404와 성공한 빈 배열을 구분하고 기존 호출 동작을 보존한다', async () => {
  let missing = false;
  const calls = [];
  const api = loadWithMocks(require.resolve('../src/services/riotService'), {
    axios: { async get(url) {
      calls.push(url);
      if (missing) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      return { data: [], headers: {} };
    } },
  });
  assert.deepEqual(await api.getRankByPuuid('p uuid', { throwOnNotFound: true }), []);
  assert.equal(calls[0], 'https://kr.api.riotgames.com/lol/league/v4/entries/by-puuid/p%20uuid');
  missing = true;
  await assert.rejects(api.getRankByPuuid('p', { throwOnNotFound: true }));
  assert.deepEqual(await api.getRankByPuuid('p'), []);
});

test('취소된 Spectator·rank 요청은 기존 Riot 큐에서 실제 HTTP 호출을 하지 않는다', async () => {
  let calls = 0;
  const api = loadWithMocks(require.resolve('../src/services/riotService'), {
    axios: { async get() { calls++; throw new Error('must not send'); } },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.getLiveGame('p', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(api.getRankByPuuid('p', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
