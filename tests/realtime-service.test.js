'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeService, getSoloRank } = require('../src/services/realtimeService');
const { buildRealtimeEmbed, FOOTER } = require('../src/services/realtimeLayoutService');
const { AsyncCache } = require('../src/utils/asyncCache');
const { createFixture } = require('./helpers/realtime-fixture');
const { loadWithMocks } = require('./helpers/load-with-mocks');

function setup(options = {}) {
  const fixture = createFixture();
  const service = createRealtimeService({ ...fixture, requireApiKey: false, ...options });
  return { ...fixture, ...service };
}

test('본인과 상대팀은 조회하지 않고 아군 정확히 4명만 분석·라인 정렬한다', async () => {
  const f = setup();
  const result = await f.scanTeammates('흰수염', 'KR1');
  assert.equal(result.allies.length, 4);
  assert.deepEqual(result.allies.map((p) => p.currentRole.role), ['TOP', 'JUNGLE', 'MID', 'ADC']);
  assert.deepEqual(f.calls.rank.sort(), ['ally-1', 'ally-2', 'ally-3', 'ally-4']);
  assert.deepEqual(f.calls.ids.map((x) => x[0]).sort(), ['ally-1', 'ally-2', 'ally-3', 'ally-4']);
  assert.ok(f.calls.ids.every((x) => x[1] === 20 && x[2] === 420));
  assert.equal(result.offRoleCount, 1);
  assert.equal(result.highRiskCount, 1);
  assert.equal(result.allies[1].spy.score, 85);
  assert.equal(result.allies[3].spy.score, null);
});

test('동일 matchId는 아군과 동시 명령 사이에서 한 번만 조회하고 warm cache를 재사용한다', async () => {
  const f = setup();
  const [a, b] = await Promise.all([f.scanTeammates('흰수염', 'KR1'), f.scanTeammates('흰수염', 'KR1')]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.accounts.length, 1);
  assert.equal(f.calls.live.length, 1);
  assert.equal(f.calls.rank.length, 4);
  assert.equal(f.calls.ids.length, 4);
  assert.equal(f.calls.match.length, 20);
  assert.equal(new Set(f.calls.match).size, 20);
  const before = JSON.stringify(f.calls);
  await f.scanTeammates('흰수염', 'KR1');
  assert.equal(JSON.stringify(f.calls), before);
});

test('history TTL 이후 목록은 갱신하고 완료 match와 rank 캐시는 유지한다', async () => {
  let clock = 1000;
  const f = setup({ now: () => clock });
  await f.scanTeammates('흰수염', 'KR1');
  clock += 180_001;
  await f.scanTeammates('흰수염', 'KR1');
  assert.equal(f.calls.live.length, 2);
  assert.equal(f.calls.ids.length, 8);
  assert.equal(f.calls.rank.length, 4);
  assert.equal(f.calls.match.length, 20);
});

test('공유 과거 경기가 없는 cold scan은 Riot 요청 최대 90회다', async () => {
  const f = setup();
  f.api.getRecentMatchIds = async (puuid, count, options) => {
    f.calls.ids.push([puuid, count, options.queue]);
    const offset = (Number(puuid.at(-1)) - 1) * 20;
    return Array.from({ length: 20 }, (_, i) => `KR_${offset + i}`);
  };
  await f.scanTeammates('흰수염', 'KR1');
  assert.equal(f.calls.match.length, 80);
  assert.equal(Object.values(f.calls).reduce((sum, calls) => sum + calls.length, 0), 90);
});

test('Solo/Duo Unranked와 rank API 실패를 구분하고 실패를 캐시하지 않는다', async () => {
  const f = setup();
  f.state.unranked = 'ally-1';
  f.state.rankError = 'ally-3';
  const first = await f.scanTeammates('흰수염', 'KR1');
  assert.equal(first.allies[0].rank.status, 'unranked');
  assert.equal(first.allies[2].rank.status, 'error');
  assert.equal(first.allies[0].spy.score, first.allies[2].spy.score);
  const embed = buildRealtimeEmbed(first).toJSON();
  assert.match(embed.fields[0].value, /^Unranked/);
  assert.match(embed.fields[2].value, /^조회 실패/);
  f.state.rankError = null;
  const next = await f.scanTeammates('흰수염', 'KR1');
  assert.equal(next.allies[2].rank.status, 'ranked');
  assert.equal(f.calls.rank.filter((id) => id === 'ally-3').length, 2);
  assert.throws(() => getSoloRank(null));
});

test('PUUID 또는 Riot ID가 없는 참가자는 전적·랭크 조회와 점수에서 제외한다', async () => {
  for (const field of ['puuid', 'riotId']) {
    const f = setup();
    f.participants[1][field] = '';
    const result = await f.scanTeammates('흰수염', 'KR1');
    const hidden = result.allies.find((p) => p.private);
    assert.ok(hidden);
    assert.equal(hidden.spy.score, null);
    assert.equal(result.allies.length, 4);
    assert.equal(f.calls.rank.length, 3);
    assert.equal(f.calls.ids.length, 3);
    assert.ok(!f.calls.rank.includes('ally-1'));
    const embed = buildRealtimeEmbed(result).toJSON();
    assert.ok(embed.fields.some((field) => field.name.includes('비공개 참가자') && field.value.includes('첩자 분석 불가')));
  }
});

test('본인 PUUID를 못 찾거나 중복 팀원·6인 팀이면 추측 없이 중단한다', async () => {
  for (const kind of ['noSelf', 'duplicate', 'six']) {
    const f = setup();
    if (kind === 'noSelf') f.participants[0].puuid = 'other';
    if (kind === 'duplicate') f.participants[2].puuid = f.participants[1].puuid;
    if (kind === 'six') f.participants.push({ ...f.participants[1], puuid: 'extra' });
    await assert.rejects(f.scanTeammates('흰수염', 'KR1'), (err) => ['SELF_NOT_FOUND', 'INVALID_TEAM'].includes(err.code));
    assert.equal(f.calls.rank.length, 0);
    assert.equal(f.calls.ids.length, 0);
  }
});

test('게임 밖이면 최근 경기 AI로 대체하지 않고 ARAM에는 5개 라인을 강제로 배정하지 않는다', async () => {
  const f = setup();
  f.state.live = null;
  assert.equal((await f.scanTeammates('흰수염', 'KR1')).status, 'notInGame');
  assert.equal(f.calls.ids.length, 0);
  const aram = setup();
  aram.state.live.mapId = 12;
  await assert.rejects(aram.scanTeammates('흰수염', 'KR1'), { code: 'UNSUPPORTED_GAME' });
  assert.equal(aram.calls.rank.length, 0);
});

test('history API 실패는 패배·0판 현챔으로 평가하지 않고 다음 요청에서 복구한다', async () => {
  const f = setup();
  f.state.historyError = 'ally-2';
  const first = await f.scanTeammates('흰수염', 'KR1');
  assert.equal(first.allies[1].spy.score, null);
  assert.equal(first.highRiskCount, 0);
  assert.match(buildRealtimeEmbed(first).toJSON().fields[1].value, /조회 실패/);
  f.state.historyError = null;
  const next = await f.scanTeammates('흰수염', 'KR1');
  assert.equal(next.allies[1].spy.score, 85);
});

test('누락된 Match 상세를 정상적인 작은 표본으로 위장하지 않는다', async () => {
  const f = setup();
  f.state.detailError = 'KR_3';
  const result = await f.scanTeammates('흰수염', 'KR1');
  assert.ok(result.allies.every((p) => p.analysis.status === 'error' && p.spy.score === null));
});

test('손상된 Match 응답은 캐시에 저장하지 않아 다음 조회에서 복구할 수 있다', async () => {
  const f = setup();
  const original = f.api.getMatchDetail;
  let broken = true;
  f.api.getMatchDetail = async (...args) => {
    const match = await original(...args);
    return broken ? { ...match, info: { ...match.info, gameEndTimestamp: 0 } } : match;
  };
  const first = await f.scanTeammates('흰수염', 'KR1');
  assert.ok(first.allies.every((p) => p.spy.score === null));
  broken = false;
  const next = await f.scanTeammates('흰수염', 'KR1');
  assert.equal(next.allies[1].spy.score, 85);
});

test('전체 시간 제한은 진행 중 조회를 취소하고 확인된 rank만 출력한다', async () => {
  const fixture = createFixture();
  let cancelled = 0;
  fixture.api.getRecentMatchIds = async (_p, _n, { signal }) => new Promise((_, reject) => {
    const cancel = () => { cancelled++; reject(signal.reason); };
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
  const service = createRealtimeService({ ...fixture, requireApiKey: false, deadlineMs: 25 });
  const result = await service.scanTeammates('흰수염', 'KR1');
  assert.equal(result.timedOut, true);
  assert.equal(cancelled, 4);
  assert.ok(result.allies.every((p) => p.spy.score === null && p.rank.status === 'ranked'));
});

test('단일 Embed는 최근 9판을 그대로 표시하고 태그 3개·문자 수 한도를 지킨다', async () => {
  const f = setup();
  const result = await f.scanTeammates('흰수염', 'KR1');
  const json = buildRealtimeEmbed(result).toJSON();
  assert.equal(json.fields.length, 4);
  assert.equal(json.footer.text, FOOTER);
  assert.match(json.fields[0].value, /주챔프 아트록스 12판 58% · 레넥톤 8판 50%/);
  assert.match(json.fields[3].value, /최근 9판 4승 5패 · 44%/);
  assert.match(json.fields[3].value, /첩자 분석 보류 · 표본 부족/);
  assert.match(json.fields[1].value, /라인 꼬임 · 최근 현챔 경험 적음 · 4연패/);
  assert.doesNotMatch(JSON.stringify(json), /AI|KDA|스펠|룬|숙련도|피해 유형|상대법|enemy|ally-0/);
  assert.ok(json.fields.every((field) => field.name.length <= 256 && field.value.length <= 1024 && !field.inline));
  const size = json.title.length + json.description.length + json.footer.text.length + json.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
  assert.ok(size < 6000);
});

test('불확실한 현재 라인은 추정으로 표시하고 Discord 멘션·개행은 무력화한다', async () => {
  const f = setup();
  const result = await f.scanTeammates('흰수염', 'KR1');
  result.allies[0].currentRole.confidence = 0.4;
  result.allies[0].riotId = '@everyone\n**fake**#KR1';
  const json = buildRealtimeEmbed(result).toJSON();
  assert.match(json.fields[0].name, /TOP\(추정\)/);
  assert.doesNotMatch(json.fields[0].name, /@everyone|\n/);
});

test('공유 요청에서 한 호출의 취소는 다른 호출을 취소하지 않는다', async () => {
  const cache = new AsyncCache({ ttlMs: 1000 });
  const a = new AbortController();
  let complete;
  let cancelled = false;
  let loads = 0;
  const loader = (signal) => { loads++; signal.addEventListener('abort', () => { cancelled = true; }); return new Promise((resolve) => { complete = resolve; }); };
  const first = cache.get('key', loader, { signal: a.signal });
  const second = cache.get('key', loader);
  await Promise.resolve();
  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(cancelled, false);
  complete(42);
  assert.equal(await second, 42);
  assert.equal(loads, 1);
});

test('모든 호출이 취소되면 공유 작업도 취소하고 다음 호출은 새로 시작한다', async () => {
  const cache = new AsyncCache({ ttlMs: 1000 });
  const controller = new AbortController();
  let cancelled = false;
  const pending = cache.get('key', (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); })), { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
  assert.equal(await cache.get('key', async () => 'recovered'), 'recovered');
});

test('캐시 크기·TTL을 제한하고 실패한 값은 보관하지 않는다', async () => {
  let clock = 0;
  let loads = 0;
  const cache = new AsyncCache({ ttlMs: 10, maxEntries: 2, now: () => clock });
  const loader = async () => ++loads;
  await cache.get('a', loader); await cache.get('b', loader); await cache.get('c', loader);
  assert.equal(cache.values.size, 2);
  assert.equal(await cache.get('a', loader), 4);
  clock = 11;
  assert.equal(await cache.get('a', loader), 5);
  await assert.rejects(cache.get('bad', async () => { throw new Error('failed'); }));
  assert.equal(await cache.get('bad', loader), 6);
});

test('/전적 실시간은 LLM·기존 상세 레이아웃을 호출하지 않고 Embed 하나만 응답한다', async () => {
  const f = setup();
  const scan = await f.scanTeammates('흰수염', 'KR1');
  const forbidden = () => { throw new Error('Old analysis must not run'); };
  const command = loadWithMocks(require.resolve('../src/commands/lol.js'), {
    '../services/realtimeService': { scanTeammates: async () => scan, classifyError: (e) => e },
    '../services/riotService': { fetchLiveGameData: forbidden, fetchRecentMatchData: forbidden },
    '../services/lolAnalyzer': { analyzeLiveGame: forbidden, analyzeRecentMatches: forbidden, parseAnalysisToFields: forbidden },
    '../services/lolTrackerService': {},
    '../services/matchLayoutService': { buildLiveGameLayout: forbidden, buildSingleMatchLayout: forbidden },
  });
  const responses = [];
  await command.execute({ options: { getSubcommand: () => '실시간', getString: (name) => name === '소환사명' ? '흰수염' : 'KR1' },
    async deferReply() {}, async editReply(value) { responses.push(value); } });
  const final = responses.at(-1);
  assert.equal(final.embeds.length, 1);
  assert.equal(final.embeds[0].toJSON().fields.length, 4);
  assert.deepEqual(final.components, []);
  assert.deepEqual(final.allowedMentions, { parse: [] });
  assert.equal(final.flags, undefined);
});
