'use strict';

// /전적 실시간 게임 시작 브리핑 테스트.
// 실제 Riot API·Data Dragon·Anthropic·Discord 없이 riotService 함수와 HTTP·AI 클라이언트를 가짜로 바꿔 실행한다.
// 아래 소환사·경기는 모두 테스트 데이터다.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SRC = (...p) => path.join(ROOT, 'src', ...p);

process.env.RIOT_API_KEY = 'test-riot-key';
process.env.LIVE_BRIEFING_AI = 'off';
delete process.env.LIVE_BRIEFING_LOOKBACK_DAYS;
delete process.env.LIVE_BRIEFING_MAX_GAMES;

const riotService = require(SRC('services', 'riotService.js'));
const knowledge = require(SRC('services', 'championKnowledgeService.js'));
const analysis = require(SRC('services', 'liveBriefingAnalysis.js'));
const service = require(SRC('services', 'liveBriefingService.js'));
const layout = require(SRC('services', 'liveBriefingLayout.js'));
const sessions = require(SRC('services', 'liveBriefingSessions.js'));
const explainer = require(SRC('services', 'liveBriefingExplainer.js'));
const lolCommand = require(SRC('commands', 'lol.js'));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================
// 🧪 테스트 데이터
// ============================================
const CHAMPS = {
  86: { dataId: 'Garen', name: '가렌', lean: 'physical' },
  64: { dataId: 'LeeSin', name: '리 신', lean: 'physical' },
  103: { dataId: 'Ahri', name: '아리', lean: 'magic', cc: true },
  222: { dataId: 'Jinx', name: '징크스', lean: 'physical' },
  89: { dataId: 'Leona', name: '레오나', lean: 'mixed', cc: true },
  122: { dataId: 'Darius', name: '다리우스', lean: 'physical', cc: true },
  104: { dataId: 'Graves', name: '그레이브즈', lean: 'physical' },
  238: { dataId: 'Zed', name: '제드', lean: 'physical' },
  51: { dataId: 'Caitlyn', name: '케이틀린', lean: 'physical', cc: true },
  99: { dataId: 'Lux', name: '럭스', lean: 'magic', cc: true },
};
const FLASH = 4;
const SMITE = 11;
const IGNITE = 14;

// slot 순서: 블루 0~4, 레드 5~9
const LINEUP = [
  { puuid: 'p-blue-top', championId: 86, teamId: 100, role: 'TOP' },
  { puuid: 'p-blue-jg', championId: 64, teamId: 100, role: 'JUNGLE', smite: true },
  { puuid: 'p-blue-mid', championId: 103, teamId: 100, role: 'MIDDLE' },
  { puuid: 'p-blue-adc', championId: 222, teamId: 100, role: 'BOTTOM' },
  { puuid: 'p-blue-sup', championId: 89, teamId: 100, role: 'UTILITY' },
  { puuid: 'p-red-top', championId: 122, teamId: 200, role: 'TOP' },
  { puuid: 'p-red-jg', championId: 104, teamId: 200, role: 'JUNGLE', smite: true },
  { puuid: 'p-red-mid', championId: 238, teamId: 200, role: 'MIDDLE' },
  { puuid: 'p-red-adc', championId: 51, teamId: 200, role: 'BOTTOM' },
  { puuid: 'p-red-sup', championId: 99, teamId: 200, role: 'UTILITY' },
];

function liveGameFrom(lineup, { gameId = 7001, queueId = 420, mapId = 11 } = {}) {
  return {
    gameId,
    mapId,
    gameMode: 'CLASSIC',
    gameQueueConfigId: queueId,
    platformId: 'KR',
    gameStartTime: NOW - 60 * 1000,
    participants: lineup.map((p) => ({
      puuid: p.puuid ?? null,
      teamId: p.teamId,
      championId: p.championId,
      spell1Id: FLASH,
      spell2Id: p.smite ? SMITE : IGNITE,
      bot: false,
      riotId: p.riotId,
      perks: { perkIds: [8112, 8126], perkStyle: 8100, perkSubStyle: 8300 },
    })),
  };
}

function matchDetail(matchId, puuid, g) {
  return {
    metadata: { matchId },
    info: {
      queueId: g.queueId ?? 420,
      gameEndTimestamp: g.endMs ?? NOW - DAY,
      endOfGameResult: g.endOfGameResult ?? 'GameComplete',
      participants: [
        {
          puuid,
          championId: g.championId,
          win: g.win ?? true,
          kills: g.kills ?? 5,
          deaths: g.deaths ?? 3,
          assists: g.assists ?? 7,
          teamPosition: g.teamPosition ?? '',
          gameEndedInEarlySurrender: g.remake === true,
        },
        { puuid: `${puuid}-other`, championId: 1, win: !(g.win ?? true), kills: 1, deaths: 1, assists: 1, teamPosition: 'TOP' },
      ],
    },
  };
}

/** 참가자마다 count개의 경기를 만든다. champGames개는 현재 챔피언, 나머지는 다른 챔피언 (포지션은 main 역할) */
function buildWorld(lineup, { count = 20, champGames = 5, overrides = {} } = {}) {
  const ids = {};
  const details = {};
  for (const p of lineup) {
    if (!p.puuid) continue;
    const custom = overrides[p.puuid];
    const games = custom || Array.from({ length: count }, (_, i) => ({
      championId: i < champGames ? p.championId : 1,
      teamPosition: p.role,
      win: i % 3 !== 0,
      endMs: NOW - (i + 1) * 60 * 60 * 1000,
    }));
    ids[p.puuid] = games.map((g, i) => g.matchId || `KR_${p.puuid}_${i}`);
    games.forEach((g, i) => {
      const id = ids[p.puuid][i];
      if (g.detail === null) return;
      details[id] = matchDetail(id, p.puuid, { championId: p.championId, ...g });
    });
  }
  return { ids, details };
}

function httpError(status, headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.isAxiosError = true;
  err.response = { status, headers };
  return err;
}

function abortErr() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function wait(ms, signal) {
  if (!ms) return signal?.aborted ? Promise.reject(abortErr()) : Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortErr());
    }, { once: true });
  });
}

const ORIGINAL_RIOT = { ...riotService };

/**
 * riotService 함수를 가짜로 교체한다. 호출 기록을 반환한다.
 */
function installRiot({
  live = liveGameFrom(LINEUP),
  account = null,
  ids = {},
  details = {},
  ranks = {},
  rankErrors = {},
  idsErrors = {},
  detailErrors = {},
  mastery = {},
  detailDelayMs = 0,
} = {}) {
  const calls = { account: 0, live: 0, rank: [], ids: [], detail: [], mastery: [] };
  Object.assign(riotService, {
    initStaticData: async () => {},
    getStaticDataInfo: () => ({ version: '16.19.1', updatedAt: '2026-09-27T00:00:00.000Z' }),
    getChampionName: (id) => CHAMPS[id]?.name || `챔피언(${id})`,
    getChampionDataId: (id) => CHAMPS[id]?.dataId || null,
    getSpellName: (id) => ({ [FLASH]: '점멸', [SMITE]: '강타', [IGNITE]: '점화' }[id] || `스펠(${id})`),
    async getAccountByRiotId(gameName, tagLine) {
      calls.account++;
      if (account === 'notFound') {
        const err = new Error('없음');
        err.notFound = true;
        throw err;
      }
      return account || { puuid: 'p-blue-mid', gameName, tagLine };
    },
    async getLiveGame(puuid) {
      calls.live++;
      return typeof live === 'function' ? live(puuid) : live;
    },
    async getLeagueEntriesByPuuid(puuid) {
      calls.rank.push(puuid);
      if (rankErrors[puuid]) throw rankErrors[puuid];
      if (Object.prototype.hasOwnProperty.call(ranks, puuid)) return ranks[puuid];
      return [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 45, wins: 30, losses: 25 }];
    },
    async getRecentMatchIds(puuid, count, options) {
      calls.ids.push({ puuid, count, options });
      if (idsErrors[puuid]) throw idsErrors[puuid];
      return ids[puuid] || [];
    },
    async getMatchDetail(matchId, options = {}) {
      calls.detail.push(matchId);
      await wait(detailDelayMs, options.signal);
      if (detailErrors[matchId]) throw detailErrors[matchId];
      return Object.prototype.hasOwnProperty.call(details, matchId) ? details[matchId] : null;
    },
    async getChampionMastery(puuid, championId) {
      calls.mastery.push(puuid);
      return mastery[puuid] ?? null;
    },
  });
  return calls;
}

function ddragonChampion(championId, { tips = true, unresolvedTip = false } = {}) {
  const c = CHAMPS[championId];
  const info = { physical: { attack: 8, magic: 2 }, magic: { attack: 2, magic: 8 }, mixed: { attack: 5, magic: 5 } }[c.lean];
  return {
    data: {
      [c.dataId]: {
        id: c.dataId,
        name: c.name,
        tags: ['Fighter'],
        info: { ...info, defense: 5, difficulty: 5 },
        allytips: tips ? [`${c.name} 아군 팁: 스킬을 연계하세요.`] : [],
        enemytips: tips
          ? [unresolvedTip ? `피해량 {{ e1 }} 주의` : `${c.name}의 핵심 스킬이 빠졌을 때 공격하세요.`]
          : [],
        spells: [
          { name: `${c.name} Q`, description: c.cc ? '적을 1초 동안 기절시킵니다.' : '피해를 줍니다.' },
          { name: `${c.name} W`, description: '이동 속도가 증가합니다.' },
          { name: `${c.name} E`, description: '둔화시킵니다.' },
          { name: `${c.name} R`, description: '큰 피해를 줍니다.' },
        ],
        passive: { name: '패시브', description: '기본 공격이 강화됩니다.' },
      },
    },
  };
}

function installDdragon({ tips = true, unresolvedFor = [], failFor = [] } = {}) {
  const calls = [];
  knowledge.__testing.setHttpGet(async (url) => {
    calls.push(url);
    if (url.endsWith('runesReforged.json')) {
      return [{ id: 8100, name: '지배', slots: [{ runes: [{ id: 8112, name: '감전' }] }] }];
    }
    const dataId = url.match(/champion\/([A-Za-z]+)\.json$/)[1];
    const championId = Number(Object.keys(CHAMPS).find((id) => CHAMPS[id].dataId === dataId));
    if (failFor.includes(championId)) throw new Error('ddragon down');
    return ddragonChampion(championId, { tips, unresolvedTip: unresolvedFor.includes(championId) });
  });
  return calls;
}

const EMPTY_CURATED = { matchups: [], traits: {}, stats: { matchups: { verified: 0, draft: 0, rejected: [] }, traits: { verified: 0, draft: 0, rejected: [] } } };

function resetAll() {
  Object.assign(riotService, ORIGINAL_RIOT);
  service.__testing.reset();
  knowledge.__testing.reset();
  knowledge.__testing.setCurated(EMPTY_CURATED);
  sessions.__testing.reset();
  explainer.__testing.setClientFactory(() => null);
  process.env.LIVE_BRIEFING_AI = 'off';
}

test.beforeEach(resetAll);
test.after(() => {
  Object.assign(riotService, ORIGINAL_RIOT);
  knowledge.__testing.reset();
});

async function briefingFor(targetPuuid, riotOptions = {}, worldOptions = {}) {
  const world = buildWorld(LINEUP, worldOptions);
  const calls = installRiot({ ...world, account: { puuid: targetPuuid, gameName: '테스트', tagLine: 'KR1' }, ...riotOptions });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: '테스트', tagLine: 'KR1' });
  return { model, calls, world };
}

function allEmbedText(payload) {
  return payload.embeds
    .map((e) => {
      const d = e.data;
      return [d.title, d.description, ...(d.fields || []).flatMap((f) => [f.name, f.value]), d.footer?.text].join('\n');
    })
    .join('\n');
}

// ============================================
// 1. 블루·레드 어디서 조회해도 내 팀·상대 팀·내 챔피언이 맞다
// ============================================
test('1. 조회 대상이 블루/레드일 때 각각 내 팀·상대 팀·내 챔피언·맞라인을 PUUID로 연결한다', async () => {
  const blue = await briefingFor('p-blue-mid');
  const b = service.buildBriefing(blue.model);
  assert.equal(b.perspective.mode, 'personal');
  assert.equal(b.perspective.target.championName, '아리');
  assert.equal(b.perspective.allyTeamId, 100);
  assert.equal(b.perspective.enemyTeamId, 200);
  assert.deepEqual(b.perspective.lane.opponents.map((p) => p.championName), ['제드']);
  assert.equal(b.perspective.myRole.role, 'MIDDLE');
  assert.equal(b.perspective.myRole.level, 'estimated');

  resetAll();
  const red = await briefingFor('p-red-mid');
  const r = service.buildBriefing(red.model);
  assert.equal(r.perspective.target.championName, '제드');
  assert.equal(r.perspective.allyTeamId, 200);
  assert.equal(r.perspective.enemyTeamId, 100);
  assert.deepEqual(r.perspective.lane.opponents.map((p) => p.championName), ['아리']);
  assert.ok(r.perspective.allies.every((p) => p.teamId === 200));

  const text = allEmbedText(layout.renderBriefing(red.model));
  assert.match(text, /\*\*제드\*\* · 우리 팀 레드 팀/);
});

// ============================================
// 2. PUUID 불일치·비공개 참가자
// ============================================
test('2. 조회 대상 PUUID가 참가자에 없으면 다른 사람 관점으로 분석하지 않고 일반 정보만 표시한다', async () => {
  const lineup = LINEUP.map((p) => (p.puuid === 'p-blue-mid' ? { ...p, puuid: null } : p));
  const world = buildWorld(lineup);
  const calls = installRiot({ ...world, live: liveGameFrom(lineup), account: { puuid: 'p-blue-mid', gameName: 'x', tagLine: 'y' } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'x', tagLine: 'y' });
  const b = service.buildBriefing(model);
  assert.equal(b.perspective.mode, 'general');
  assert.equal(b.content.cautions.length, 0);
  assert.equal(b.content.options.length, 0);

  // 비공개 참가자에게는 Riot 조회를 하지 않고 챔피언 정보만 쓴다
  const hidden = model.participants.find((p) => p.championId === 103);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.rank.status, 'hidden');
  assert.equal(hidden.history.status, 'hidden');
  assert.equal(calls.rank.includes(null), false);
  assert.equal(calls.rank.length, 9);

  const payload = layout.renderBriefing(model, { sessionId: 'aaaaaaaaaaaa' });
  const text = allEmbedText(payload);
  assert.match(text, /연결하지 못해 사용자 맞춤 분석을 생략/);
  assert.doesNotMatch(text, /내 포지션/);
  // 라인 버튼 비활성, 포지션 지정 메뉴 없음
  const laneButton = payload.components[0].components.find((c) => c.data.custom_id.endsWith(':lane'));
  assert.equal(laneButton.data.disabled, true);
  assert.equal(payload.components.length, 1);
});

// ============================================
// 3. 큐·기간 필터, 중복 제거, 빈 전적, 일부 실패
// ============================================
test('3. 동일 큐·기간으로 조회하고 중복 matchId를 제거하며, 정상 빈 전적과 일부 상세 실패를 구분한다', async () => {
  const world = buildWorld(LINEUP, { count: 6 });
  const mid = 'p-blue-mid';
  world.ids[mid] = [...world.ids[mid], world.ids[mid][0], world.ids[mid][1]]; // 중복
  world.ids['p-red-mid'] = []; // 정상 빈 전적
  const failedId = world.ids['p-blue-top'][2];
  const calls = installRiot({
    ...world,
    account: { puuid: mid, gameName: 'a', tagLine: 'b' },
    detailErrors: { [failedId]: httpError(500) },
  });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });

  const call = calls.ids.find((c) => c.puuid === mid);
  assert.equal(call.options.queue, 420);
  assert.equal(call.count, 20);
  const expectedStart = Math.floor((Date.now() - 60 * DAY) / 1000);
  assert.ok(Math.abs(call.options.startTime - expectedStart) < 5);
  assert.equal(call.options.throwOnNotFound, true);

  const me = model.participants.find((p) => p.puuid === mid);
  assert.equal(me.stats.idsFound, 6);
  assert.equal(new Set(calls.detail.filter((id) => id.startsWith(`KR_${mid}_`))).size, 6);

  const emptyPlayer = model.participants.find((p) => p.puuid === 'p-red-mid');
  assert.equal(emptyPlayer.history.status, 'ok');
  assert.equal(emptyPlayer.stats.collected, 0);
  assert.match(layout.formatRecord(emptyPlayer, model.settings), /완료 경기 없음/);

  const top = model.participants.find((p) => p.puuid === 'p-blue-top');
  assert.equal(top.stats.failed, 1);
  assert.equal(top.stats.collected, 5);
  assert.match(layout.formatRecord(top, model.settings), /최근 수집 5경기.*실패 1/);

  // 다른 큐 경기가 섞여 와도 집계하지 않는다
  const h = { ids: ['A', 'B'], entries: [
    { matchId: 'A', ...analysis.evaluateMatchFor(analysis.compactMatch(matchDetail('A', 'u', { championId: 1, queueId: 440 }), 'A'), 'u', { queueId: 420, cutoffMs: 0 }) },
    { matchId: 'B', ...analysis.evaluateMatchFor(analysis.compactMatch(matchDetail('B', 'u', { championId: 1, endMs: NOW - 90 * DAY }), 'B'), 'u', { queueId: 420, cutoffMs: NOW - 60 * DAY }) },
  ] };
  const agg = analysis.aggregateHistory(h, 1);
  assert.equal(agg.collected, 0);
  assert.equal(agg.excluded.queue, 1);
  assert.equal(agg.excluded.period, 1);
});

// ============================================
// 4. 집계 경계
// ============================================
test('4. 챔피언 0경기·소표본·데스 0·중간 누락·다시하기를 규칙대로 처리한다', () => {
  const entry = (matchId, game) => ({ matchId, state: 'ok', game: { championId: 1, kills: 2, deaths: 0, assists: 3, teamPosition: 'MIDDLE', win: true, ...game } });
  const history = {
    ids: ['m1', 'm2', 'm3', 'm4', 'm5'],
    entries: [
      entry('m1', { win: true }),
      { matchId: 'm2', state: 'excluded', reason: 'remake' },
      entry('m3', { win: true }),
      { matchId: 'm4', state: 'failed', reason: 'upstream' },
      entry('m5', { win: false }),
    ],
  };
  const agg = analysis.aggregateHistory(history, 999);
  assert.equal(agg.collected, 3);
  assert.equal(agg.excluded.remake, 1);
  assert.equal(agg.failed, 1);
  assert.equal(agg.wins, 2);
  assert.equal(agg.winPermil, 667);
  assert.deepEqual(agg.kda, { deathless: true, hundredths: null });
  assert.equal(analysis.formatKda(agg.kda), '데스 없음');
  // 다시하기는 건너뛰고, 누락을 만나 그 너머를 모르므로 '최소'
  assert.deepEqual(agg.streak, { win: true, count: 2, atLeast: true });
  assert.equal(analysis.formatStreak(agg.streak), '최소 2연승');
  assert.equal(agg.smallSample, true);
  assert.equal(agg.champion.games, 0);

  const p = { championName: '아리', stats: agg, history: { status: 'ok' } };
  const sample = layout.formatChampionSample(p);
  assert.match(sample, /최근 수집 3경기 중 아리 경기 없음/);
  assert.doesNotMatch(sample, /첫 판|처음/);
  assert.match(layout.formatRecord(p, { lookbackDays: 60 }), /표본 적음/);
  assert.doesNotMatch(layout.formatRecord(p, { lookbackDays: 60 }), /최근 20전/);

  // 다시하기 판정은 Riot 필드 기준이며 경기 시간만으로 제외하지 않는다
  const remake = analysis.compactMatch(matchDetail('r', 'u', { championId: 1, remake: true }), 'r');
  assert.deepEqual(analysis.evaluateMatchFor(remake, 'u', { queueId: 420, cutoffMs: 0 }), { state: 'excluded', reason: 'remake' });
  const notCompleted = analysis.compactMatch(matchDetail('n', 'u', { championId: 1, endOfGameResult: 'Abort_Unexpected' }), 'n');
  assert.equal(analysis.evaluateMatchFor(notCompleted, 'u', { queueId: 420, cutoffMs: 0 }).reason, 'notCompleted');

  // 합산 KDA = (총 킬 + 총 어시) / 총 데스
  assert.deepEqual(analysis.combinedKda(10, 4, 6), { deathless: false, hundredths: 400 });
});

// ============================================
// 5. 랭크 상태 구분
// ============================================
test('5. 정상 빈 랭크와 401/403/429/5xx/시간 초과/404가 서로 다른 상태로 남고, 실패는 캐시하지 않는다', async () => {
  const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true });
  const { model, calls } = await briefingFor('p-blue-mid', {
    ranks: { 'p-blue-top': [], 'p-blue-jg': null },
    rankErrors: {
      'p-blue-adc': httpError(401),
      'p-blue-sup': httpError(403),
      'p-red-top': httpError(429, { 'retry-after': '1' }),
      'p-red-jg': httpError(503),
      'p-red-mid': timeout,
    },
  });
  const rankOf = (puuid) => model.participants.find((p) => p.puuid === puuid).rank;
  assert.equal(rankOf('p-blue-mid').status, 'ranked');
  assert.deepEqual(rankOf('p-blue-top'), { status: 'unranked', queueType: 'RANKED_SOLO_5x5' });
  assert.deepEqual(rankOf('p-blue-jg'), { status: 'error', reason: 'notFound' });
  assert.deepEqual(rankOf('p-blue-adc'), { status: 'error', reason: 'auth' });
  assert.deepEqual(rankOf('p-blue-sup'), { status: 'error', reason: 'auth' });
  assert.deepEqual(rankOf('p-red-top'), { status: 'error', reason: 'rateLimited' });
  assert.deepEqual(rankOf('p-red-jg'), { status: 'error', reason: 'upstream' });
  assert.deepEqual(rankOf('p-red-mid'), { status: 'error', reason: 'timeout' });

  assert.equal(layout.formatRank(rankOf('p-blue-top')), '솔로랭크 기록 없음');
  assert.equal(layout.formatRank(rankOf('p-red-top')), '랭크 조회 실패(요청 한도)');
  assert.notEqual(layout.formatRank(rankOf('p-red-jg')), '솔로랭크 기록 없음');

  // 한 사람의 실패가 다른 사람 분석을 막지 않는다
  assert.equal(model.participants.filter((p) => p.history.status === 'ok').length, 10);

  // 실패한 랭크는 다음 조회에서 다시 시도하고, 성공한 랭크는 캐시에서 쓴다
  const before = calls.rank.length;
  await service.createLiveBriefing({ gameName: '테스트', tagLine: 'KR1' });
  const retried = calls.rank.slice(before);
  assert.ok(retried.includes('p-red-top'));
  assert.ok(!retried.includes('p-blue-mid'));

  // 자유랭크 게임은 자유랭크 엔트리를 본다
  assert.equal(analysis.rankQueueTypeFor(440), 'RANKED_FLEX_SR');
});

// ============================================
// 6. 역할 추정: 허위 확정 금지
// ============================================
function teamPlayer(slot, { positions = {}, champPositions = {}, smite = false } = {}) {
  const full = (obj) => ({ TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0, ...obj });
  return { slot, hasSmite: smite, stats: { positions: full(positions), champion: { positions: full(champPositions) } } };
}

test('6. 멀티포지션·강타 중복·지원하지 않는 모드·동점 배치에서 포지션을 확정하지 않는다', () => {
  const clear = [
    teamPlayer(0, { positions: { TOP: 10 } }),
    teamPlayer(1, { positions: { JUNGLE: 10 }, smite: true }),
    teamPlayer(2, { positions: { MIDDLE: 10 } }),
    teamPlayer(3, { positions: { BOTTOM: 10 } }),
    teamPlayer(4, { positions: { UTILITY: 10 } }),
  ];
  const ok = analysis.assignTeamRoles(clear);
  assert.deepEqual([...ok.values()].map((r) => r.role), ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
  assert.ok([...ok.values()].every((r) => r.level === 'estimated'));
  assert.ok([...ok.values()].every((r) => r.level !== 'confirmed'));

  // 미드 기록이 같은 두 사람 (동점) → 두 사람 모두 불확실, 같은 팀에 미드 중복 없음
  const tie = [
    teamPlayer(0, { positions: { MIDDLE: 10 } }),
    teamPlayer(1, { positions: { JUNGLE: 10 }, smite: true }),
    teamPlayer(2, { positions: { MIDDLE: 10 } }),
    teamPlayer(3, { positions: { BOTTOM: 10 } }),
    teamPlayer(4, { positions: { UTILITY: 10 } }),
  ];
  const t = analysis.assignTeamRoles(tie);
  assert.equal(t.get(0).level, 'uncertain');
  assert.equal(t.get(2).level, 'uncertain');
  assert.equal(t.get(0).role, null);
  const assigned = [...t.values()].map((r) => r.role).filter(Boolean);
  assert.equal(new Set(assigned).size, assigned.length);

  // 강타 두 명, 기록 없음 → 누구도 정글로 확정하지 않는다
  const doubleSmite = [
    teamPlayer(0, { smite: true }),
    teamPlayer(1, { smite: true }),
    teamPlayer(2, { positions: { MIDDLE: 10 } }),
    teamPlayer(3, { positions: { BOTTOM: 10 } }),
    teamPlayer(4, { positions: { UTILITY: 10 } }),
  ];
  const d = analysis.assignTeamRoles(doubleSmite);
  assert.equal(d.get(0).level, 'uncertain');
  assert.equal(d.get(1).level, 'uncertain');

  // 탑/미드 반반인 멀티포지션 + 같은 성향의 다른 사람 → 불확실
  const multi = [
    teamPlayer(0, { positions: { TOP: 5, MIDDLE: 5 } }),
    teamPlayer(1, { positions: { JUNGLE: 10 }, smite: true }),
    teamPlayer(2, { positions: { TOP: 5, MIDDLE: 5 } }),
    teamPlayer(3, { positions: { BOTTOM: 10 } }),
    teamPlayer(4, { positions: { UTILITY: 10 } }),
  ];
  const m = analysis.assignTeamRoles(multi);
  assert.equal(m.get(0).level, 'uncertain');
  assert.equal(m.get(2).level, 'uncertain');
  assert.equal(m.get(1).role, 'JUNGLE');

  // 기록이 1경기뿐이면 근거 부족
  const thin = [...clear];
  thin[2] = teamPlayer(2, { positions: { MIDDLE: 1 } });
  assert.equal(analysis.assignTeamRoles(thin).get(2).level, 'uncertain');

  // 지원하지 않는 모드(칼바람)는 역할·라인 분석을 하지 않는다
  const model = {
    game: { queueId: 450, mapId: 12 },
    targetPuuid: 'p-blue-mid',
    participants: LINEUP.map((p, slot) => ({ ...p, slot, championName: CHAMPS[p.championId].name, hasSmite: false, stats: null })),
  };
  const aram = analysis.buildPerspective(model);
  assert.equal(aram.roleSupported, false);
  assert.equal(aram.lane.type, 'none');
  assert.equal(aram.myRole.level, 'unsupported');
});

// ============================================
// 7. 바텀 듀오·정글
// ============================================
test('7. 바텀은 양측 듀오를 함께 다루고, 정글은 맞라인으로 표현하지 않는다', async () => {
  const adc = await briefingFor('p-blue-adc');
  const b = service.buildBriefing(adc.model);
  assert.equal(b.perspective.lane.type, 'bottom');
  assert.deepEqual(b.perspective.lane.allyDuo.map((p) => p.championName).sort(), ['레오나', '징크스'].sort());
  assert.deepEqual(b.perspective.lane.opponents.map((p) => p.championName).sort(), ['럭스', '케이틀린'].sort());
  assert.match(allEmbedText(layout.renderBriefing(adc.model)), /우리 바텀: .*\/ 상대 바텀: /);

  resetAll();
  const jg = await briefingFor('p-blue-jg');
  const j = service.buildBriefing(jg.model);
  assert.equal(j.perspective.lane.type, 'jungle');
  const text = allEmbedText(layout.renderBriefing(jg.model));
  assert.match(text, /정글은 맞라인 상대가 아닙니다/);
  assert.match(text, /현재 위치·동선은 추측하지 않습니다/);
  assert.doesNotMatch(text, /상대 후보:/);
});

// ============================================
// 8. 상대법 자료 계층과 대체 출력
// ============================================
function verifiedMatchup(overrides = {}) {
  return {
    id: 'ahri-vs-zed-test',
    myChampion: 'Ahri',
    opponentChampion: 'Zed',
    role: 'MIDDLE',
    queues: [420],
    lastVerifiedPatch: '16.19',
    cautions: ['테스트 검수 주의 문장'],
    options: ['테스트 검수 운영 문장'],
    numericClaimsSource: null,
    source: { type: 'self-review', ref: '테스트 검수 기록' },
    checkedAt: '2026-09-27',
    reviewStatus: 'verified',
    reviewedBy: '테스트 검수자',
    ...overrides,
  };
}

test('8. 검수 상대법 → 공식 일반 팁 → 자료 없음 순서로 대체하고, 패치 불명·미검수·수치 근거 없음을 구분한다', async () => {
  // (a) 검수 완료 + 패치 명시
  const parsed = knowledge.parseMatchups({ entries: [verifiedMatchup()] });
  knowledge.__testing.setCurated({ ...EMPTY_CURATED, matchups: parsed.verified });
  const { model } = await briefingFor('p-blue-mid');
  let b = service.buildBriefing(model);
  assert.equal(b.content.cautions[0].source, 'verified-matchup');
  let text = allEmbedText(layout.renderBriefing(model));
  assert.match(text, /테스트 검수 주의 문장/);
  assert.match(text, /검수 상대법 · 패치 16\.19/);

  // (b) 검수 완료지만 패치 불명
  knowledge.__testing.setCurated({ ...EMPTY_CURATED, matchups: knowledge.parseMatchups({ entries: [verifiedMatchup({ lastVerifiedPatch: null })] }).verified });
  text = allEmbedText(layout.renderBriefing(model));
  assert.match(text, /적용 패치 미확인/);

  // (c) 미검수(draft)는 쓰지 않는다 → 공식 일반 팁으로 대체
  const draft = knowledge.parseMatchups({ entries: [verifiedMatchup({ reviewStatus: 'draft' })] });
  assert.equal(draft.verified.length, 0);
  assert.equal(draft.stats.draft, 1);
  knowledge.__testing.setCurated({ ...EMPTY_CURATED, matchups: draft.verified });
  b = service.buildBriefing(model);
  assert.equal(b.content.cautions[0].source, 'official-tip');
  text = allEmbedText(layout.renderBriefing(model));
  assert.match(text, /제드 공식 일반 팁/);
  assert.match(text, /검증된 상대법 자료 없음/);
  const laneText = allEmbedText(layout.renderBriefing(model, { view: 'lane' }));
  assert.match(laneText, /이 매치업 전용 조언이 아닙니다/);

  // (d) 수치가 있는데 별도 근거가 없으면 검수 완료여도 거부
  const numeric = knowledge.parseMatchups({ entries: [verifiedMatchup({ cautions: ['쿨다운 12초 동안 공격'] })] });
  assert.equal(numeric.verified.length, 0);
  assert.match(numeric.stats.rejected[0], /수치/);

  // (e) 공식 팁도 없음 → '자료 없음'만
  resetAll();
  const world = buildWorld(LINEUP);
  installRiot({ ...world, account: { puuid: 'p-blue-mid', gameName: 'a', tagLine: 'b' } });
  installDdragon({ tips: false });
  const bare = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });
  const bareBriefing = service.buildBriefing(bare);
  assert.ok(bareBriefing.content.cautions.every((c) => c.source !== 'official-tip'));
  assert.match(allEmbedText(layout.renderBriefing(bare, { view: 'lane' })), /공식 일반 팁도 없습니다/);

  // (f) 하드 CC 키워드: 자기 자신·미니언 대상 설명과 '공포 감지' 같은 비CC 표현은 세지 않는다
  const cc = (description) => knowledge.detectHardCc([{ name: 'Q', description }]).length > 0;
  assert.equal(cc('그물을 발사하여 적을 느리게 합니다. 그 반동으로 케이틀린은 뒤로 밀려납니다.'), false);
  assert.equal(cc('챔피언이 아닌 유닛이 탄환을 여러 개 맞으면 뒤로 밀려납니다.'), false);
  assert.equal(cc('근처 적 미니언에게 공포를 주고 공격력이 증가합니다.'), false);
  assert.equal(cc('기본 공격과 공포 감지 범위도 증가합니다.'), false);
  assert.equal(cc('지정한 지역에 빛의 구체를 띄워 주변 적의 속도를 늦춥니다.'), false);
  assert.equal(cc('강력한 돌려차기로 적 챔피언을 뒤로 밀어냅니다.'), true);
  assert.equal(cc('적을 1초 동안 기절시킵니다.'), true);
  assert.deepEqual(knowledge.detectHardCc([], { name: '패시브', description: '다섯 번째 스킬은 적을 기절시킵니다.' })[0].slot, '패시브');

  // (g) 미치환 변수가 있는 공식 문장은 노출하지 않는다
  assert.equal(knowledge.cleanOfficialText('피해량 {{ e1 }} 주의'), null);
  assert.equal(knowledge.cleanOfficialText('@Effect1Amount@의 피해'), null);
  assert.equal(knowledge.cleanOfficialText('<br>정상 문장'), '정상 문장');
});

// ============================================
// 9. AI 설명 검증과 템플릿 복구
// ============================================
function sampleContent() {
  return {
    facts: [{ id: 'F1', subject: 'ENEMY_LANE', text: '제드(미드 후보): 최근 수집 18경기 중 해당 챔피언 9경기(5승 4패)' }],
    cautions: [{ id: 'C1', source: 'record', text: '상대 제드: 최근 수집 18경기 중 해당 챔피언 9경기로 이 챔피언 표본이 많습니다.', factIds: ['F1'] }],
    options: [],
  };
}

test('9. AI 시간 초과·잘못된 JSON·알 수 없는 ID·입력에 없는 수치·승률 생성은 모두 템플릿으로 복구한다', async () => {
  const content = sampleContent();
  const ok = explainer.validateExplanation('{"items":[{"id":"C1","text":"상대 제드는 최근 수집 18경기 중 9경기를 제드로 했습니다."}]}', content);
  assert.equal(ok.ok, true);

  const cases = {
    'JSON 파싱 실패': 'not json',
    '알 수 없는 id': '{"items":[{"id":"C9","text":"문장"}]}',
    '금지 표현(%)': '{"items":[{"id":"C1","text":"제드 승률 55%라 위험합니다."}]}',
    '입력에 없는 수치': '{"items":[{"id":"C1","text":"제드 쿨다운은 12초입니다."}]}',
    '누락된 항목': '{"items":[]}',
    '멘션': '{"items":[{"id":"C1","text":"<@123> 제드 주의"}]}',
    '가명 노출': '{"items":[{"id":"C1","text":"ENEMY_LANE 제드 주의"}]}',
  };
  for (const [label, raw] of Object.entries(cases)) {
    assert.equal(explainer.validateExplanation(raw, content).ok, false, label);
  }

  process.env.LIVE_BRIEFING_AI = 'on';
  // 시간 초과: SDK의 timeout 옵션이 전달되고, 오류는 템플릿으로 복구
  let seenOptions = null;
  explainer.__testing.setClientFactory(() => ({
    messages: {
      create: async (_body, options) => {
        seenOptions = options;
        await sleep(20);
        throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
      },
    },
  }));
  const timedOut = await explainer.explainBriefContent(content, { timeoutMs: 10 });
  assert.equal(timedOut.status, 'template');
  assert.equal(seenOptions.timeout, 10);
  assert.equal(seenOptions.maxRetries, 0);

  // 입력에 없는 승률 생성 → 템플릿
  explainer.__testing.setClientFactory(() => ({
    messages: { create: async () => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"items":[{"id":"C1","text":"이번 판 승리 확률이 높습니다"}]}' }] }) },
  }));
  assert.equal((await explainer.explainBriefContent(content)).status, 'template');

  // 정상 → AI 문장 사용. 프롬프트에 이름·PUUID가 없다
  let prompt = '';
  explainer.__testing.setClientFactory(() => ({
    messages: {
      create: async (body) => {
        prompt = body.messages[0].content;
        return { content: [{ type: 'text', text: '{"items":[{"id":"C1","text":"상대 제드는 최근 18경기 중 9경기를 제드로 했습니다."}]}' }] };
      },
    },
  }));
  const good = await explainer.explainBriefContent(content);
  assert.equal(good.status, 'ai');
  assert.equal(good.texts.get('C1'), '상대 제드는 최근 18경기 중 9경기를 제드로 했습니다.');
  assert.doesNotMatch(prompt, /p-blue|p-red|테스트#KR1/);

  // 브리핑 전체 흐름에서 AI 입력에 PUUID·표시 이름이 들어가지 않는다
  const lineup = LINEUP.map((p) => ({ ...p, riotId: `실명${p.puuid}#KR1` }));
  const world = buildWorld(lineup);
  installRiot({ ...world, live: liveGameFrom(lineup), account: { puuid: 'p-blue-mid', gameName: 'a', tagLine: 'b' } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });
  const briefing = service.buildBriefing(model);
  const aiInput = explainer.buildPrompt(briefing.content);
  assert.doesNotMatch(aiInput, /p-blue|p-red|실명/);
});

// ============================================
// 10·11. 공유 캐시와 사용자별 관점, 중복 호출 없음
// ============================================
test('10. 같은 경기를 다른 사용자가 조회하면 수집은 재사용하고 관점은 각자 기준으로 렌더링한다', async () => {
  const world = buildWorld(LINEUP);
  let target = 'p-blue-mid';
  const calls = installRiot({ ...world, account: null });
  riotService.getAccountByRiotId = async (gameName, tagLine) => ({ puuid: target, gameName, tagLine });
  installDdragon();

  const first = await service.createLiveBriefing({ gameName: 'first', tagLine: 'KR1' });
  const detailsAfterFirst = calls.detail.length;
  target = 'p-red-top';
  const second = await service.createLiveBriefing({ gameName: 'second', tagLine: 'KR1' });

  // 현재 게임 확인은 매번 한다 (지난 경기 결과를 새 경기로 보여주지 않도록)
  assert.equal(calls.live, 2);
  // 이미 수집한 경기 상세는 다시 가져오지 않는다
  const repeated = calls.detail.slice(detailsAfterFirst).filter((id) => calls.detail.indexOf(id) < detailsAfterFirst);
  assert.deepEqual(repeated, []);

  const a = service.buildBriefing(first);
  const b = service.buildBriefing(second);
  assert.equal(a.perspective.target.championName, '아리');
  assert.equal(b.perspective.target.championName, '다리우스');
  assert.equal(b.perspective.allyTeamId, 200);
  assert.match(allEmbedText(layout.renderBriefing(second)), /다리우스.*레드 팀/);
  assert.match(allEmbedText(layout.renderBriefing(first)), /아리.*블루 팀/);
});

test('11. 같은 경기 동시 조회와 버튼 반복 클릭에서 외부 호출이 중복으로 늘지 않는다', async () => {
  const world = buildWorld(LINEUP, { count: 8 });
  const calls = installRiot({ ...world, detailDelayMs: 5 });
  riotService.getAccountByRiotId = async (gameName, tagLine) => ({ puuid: gameName, gameName, tagLine });
  installDdragon();

  const [m1, m2] = await Promise.all([
    service.createLiveBriefing({ gameName: 'p-blue-mid', tagLine: 'KR1' }),
    service.createLiveBriefing({ gameName: 'p-red-mid', tagLine: 'KR1' }),
  ]);
  assert.equal(calls.detail.length, new Set(calls.detail).size, '같은 경기 상세를 두 번 가져오지 않는다');
  assert.equal(calls.ids.length, new Set(calls.ids.map((c) => c.puuid)).size);
  assert.equal(service.buildBriefing(m1).perspective.target.championName, '아리');
  assert.equal(service.buildBriefing(m2).perspective.target.championName, '제드');

  // 버튼·포지션 지정은 저장된 모델만 다시 그린다
  const session = sessions.createSession({ ownerId: 'u1', guildId: 'g1', channelId: 'c1', model: m1 });
  session.messageId = 'msg1';
  const before = { detail: calls.detail.length, rank: calls.rank.length, live: calls.live };
  for (const view of ['lane', 'allies', 'enemies', 'comp', 'home', 'lane']) {
    const interaction = fakeComponent({ customId: `lolbrief:${session.id}:view:${view}` });
    await lolCommand.handleBriefingComponent(interaction);
    assert.equal(interaction.updated.length, 1);
  }
  const roleClick = fakeComponent({ customId: `lolbrief:${session.id}:role`, values: ['TOP'] });
  await lolCommand.handleBriefingComponent(roleClick);
  assert.deepEqual({ detail: calls.detail.length, rank: calls.rank.length, live: calls.live }, before);

  // 사용자 지정 포지션은 '사용자 지정'으로 표시하고 상대 역할은 추정 그대로
  const b = service.buildBriefing(m1, { roleOverride: 'TOP' });
  assert.equal(b.perspective.myRole.level, 'user');
  assert.ok(b.perspective.enemies.every((p) => b.perspective.roles.get(p.slot).level !== 'user'));
  assert.match(allEmbedText(roleClick.updated[0]), /탑\*\* \(사용자 지정\)/);
});

// ============================================
// 12. 예산·기한·Retry-After
// ============================================
test('12. 요청당 새 경기 상세 상한과 기한을 지키고, 종료 후 남은 요청이 실행되지 않는다', async () => {
  // 10명 × 20경기 = 200개 → 한 요청은 80개까지만 새로 가져온다
  const world = buildWorld(LINEUP, { count: 20 });
  const calls = installRiot({ ...world, account: { puuid: 'p-blue-mid', gameName: 'a', tagLine: 'b' } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });
  assert.ok(calls.detail.length <= service.LIVE_CONFIG.maxNewMatchDetails, `상세 ${calls.detail.length}개`);
  assert.equal(model.collectionStats.budgetHit, true);
  // 조회 대상과 상대 후보는 목표 표본까지 먼저 보강된다
  const me = model.participants.find((p) => p.puuid === 'p-blue-mid');
  const opponent = model.participants.find((p) => p.puuid === 'p-red-mid');
  assert.equal(me.stats.collected, 20);
  assert.equal(opponent.stats.collected, 20);
  const text = allEmbedText(layout.renderBriefing(model));
  assert.match(text, /미수집/);
  assert.match(text, /요청 예산으로 일부 상세 수집을 마치지 못함/);

  // 기한: 느린 응답에서도 기한 안에 부분 결과로 끝난다
  resetAll();
  const slowWorld = buildWorld(LINEUP, { count: 20 });
  const slowCalls = installRiot({ ...slowWorld, account: { puuid: 'p-blue-mid', gameName: 'a', tagLine: 'b' }, detailDelayMs: 40 });
  installDdragon();
  const started = Date.now();
  const partial = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' }, { deadlineMs: 400 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `경과 ${elapsed}ms`);
  assert.equal(partial.stage, 'final');
  const pending = partial.participants.reduce((s, p) => s + (p.stats?.pending || 0), 0);
  assert.ok(pending > 0);
  const countAtReturn = slowCalls.detail.length;
  await sleep(150);
  assert.equal(slowCalls.detail.length, countAtReturn, '기한 후 새 요청 없음');
  const { inflight } = service.__testing.caches;
  assert.equal(inflight.match.size, 0);
});

test('12-2. 공통 Riot 큐는 429 Retry-After를 지키고, 기한이 끝나면 대기 중인 호출자를 즉시 풀어준다', async () => {
  const { loadWithMocks } = require('./helpers/load-with-mocks');
  const attempts = [];
  const fakeAxios = {
    get: async (url, options) => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw httpError(429, { 'retry-after': '1' });
      if (options?.signal?.aborted) throw abortErr();
      return { data: [], headers: {} };
    },
  };
  const riot = loadWithMocks(SRC('services', 'riotService.js'), { axios: fakeAxios });
  const t0 = Date.now();
  const entries = await riot.getLeagueEntriesByPuuid('puuid-x');
  assert.deepEqual(entries, []);
  assert.ok(attempts[1] - attempts[0] >= 950, 'Retry-After 1초 대기');
  assert.ok(Date.now() - t0 < 3000);

  // 429 대기 중 기한 종료 → 호출자는 바로 실패(부분 결과로 처리 가능), 큐 대기는 다른 요청을 위해 유지
  attempts.length = 0;
  const controller = new AbortController();
  const p = riot.getLeagueEntriesByPuuid('puuid-y', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const t1 = Date.now();
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.ok(Date.now() - t1 < 500);
  assert.equal(service.classifyFailure(Object.assign(new Error('x'), { name: 'AbortError' })), 'skipped');
  await sleep(1100); // 큐 정리
});

// ============================================
// 13. 버튼 권한·만료·Embed 길이·멘션
// ============================================
function fakeComponent({ customId, userId = 'u1', guildId = 'g1', messageId = 'msg1', values } = {}) {
  const interaction = {
    customId,
    values,
    user: { id: userId },
    guildId,
    message: { id: messageId },
    replied: false,
    deferred: false,
    updated: [],
    replies: [],
    followUps: [],
    async update(payload) {
      this.updated.push(payload);
      this.replied = true;
    },
    async reply(payload) {
      this.replies.push(payload);
      this.replied = true;
    },
    async followUp(payload) {
      this.followUps.push(payload);
    },
  };
  return interaction;
}

test('13. 다른 사람·다른 서버·만료 세션 조작을 막고, Embed 길이와 멘션을 안전하게 처리한다', async () => {
  const lineup = LINEUP.map((p) => ({ ...p, riotId: `@everyone **굵게** <@123> ${'긴이름'.repeat(40)}#KR1` }));
  const world = buildWorld(lineup);
  installRiot({ ...world, live: liveGameFrom(lineup), account: { puuid: 'p-blue-mid', gameName: '@here', tagLine: 'KR1' } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: '@here', tagLine: 'KR1' });
  const session = sessions.createSession({ ownerId: 'u1', guildId: 'g1', channelId: 'c1', model });
  session.messageId = 'msg1';

  // component ID에는 PUUID·키가 없다
  const payload = layout.renderBriefing(model, { sessionId: session.id });
  const ids = payload.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.ok(ids.every((id) => /^lolbrief:[0-9a-f]{12}:(view:[a-z]+|role)$/.test(id)));
  assert.ok(ids.every((id) => !id.includes('p-blue') && !id.includes('test-riot-key')));
  assert.deepEqual(payload.allowedMentions, { parse: [] });

  // 모든 보기에서 Embed 제한을 지키고 멘션이 무력화된다
  for (const view of ['home', 'lane', 'allies', 'enemies', 'comp']) {
    const p = layout.renderBriefing(model, { view, sessionId: session.id });
    for (const e of p.embeds) {
      assert.ok(layout.embedLength(e) <= 6000, `${view} 길이 ${layout.embedLength(e)}`);
      for (const f of e.data.fields || []) assert.ok(f.value.length <= 1024 && f.name.length <= 256);
    }
    const text = allEmbedText(p);
    assert.doesNotMatch(text, /@everyone|@here|<@123>/);
  }
  assert.match(allEmbedText(layout.renderBriefing(model, { view: 'allies' })), /\\\*\\\*굵게/);

  // 다른 사람
  const other = fakeComponent({ customId: `lolbrief:${session.id}:view:lane`, userId: 'u2' });
  await lolCommand.handleBriefingComponent(other);
  assert.equal(other.updated.length, 0);
  assert.equal(other.replies[0].ephemeral, true);
  assert.match(other.replies[0].content, /조회한 사람만/);

  // 다른 서버·다른 메시지
  const otherGuild = fakeComponent({ customId: `lolbrief:${session.id}:view:lane`, guildId: 'g2' });
  await lolCommand.handleBriefingComponent(otherGuild);
  assert.equal(otherGuild.updated.length, 0);
  const otherMessage = fakeComponent({ customId: `lolbrief:${session.id}:view:lane`, messageId: 'msg2' });
  await lolCommand.handleBriefingComponent(otherMessage);
  assert.equal(otherMessage.updated.length, 0);

  // 위조된 ID
  const forged = fakeComponent({ customId: 'lolbrief:../../x:view:home' });
  await lolCommand.handleBriefingComponent(forged);
  assert.match(forged.replies[0].content, /알 수 없는 요청/);

  // 만료: 버튼을 치우고 본인에게만 알린다
  sessions.__testing.setNow(() => Date.now() + sessions.SESSION_CONFIG.ttlMs + 1);
  const expired = fakeComponent({ customId: `lolbrief:${session.id}:view:lane` });
  await lolCommand.handleBriefingComponent(expired);
  assert.deepEqual(expired.updated[0], { components: [] });
  assert.equal(expired.followUps[0].ephemeral, true);
  assert.match(expired.followUps[0].content, /만료/);

  // 세션 수는 상한을 넘지 않는다
  sessions.__testing.reset();
  for (let i = 0; i < sessions.SESSION_CONFIG.maxSessions + 20; i++) {
    sessions.createSession({ ownerId: 'u', guildId: 'g', channelId: 'c', model });
  }
  assert.equal(sessions.__testing.sessions.size, sessions.SESSION_CONFIG.maxSessions);

  // fitEmbedData: 전체 6000자 초과 입력도 줄여서 맞춘다
  const fitted = layout.fitEmbedData({
    title: 'x'.repeat(300),
    description: 'y'.repeat(5000),
    fields: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: 'z'.repeat(2000) })),
  });
  assert.ok(fitted.fields.length <= 25);
  assert.ok(layout.embedLength(fitted) <= 6000);
});

// ============================================
// 14. /전적 실시간 전체 흐름·기존 기능 유지
// ============================================
function fakeCommandInteraction({ gameName = '테스트', tagLine = 'KR1', userId = 'u1' } = {}) {
  return {
    user: { id: userId },
    guildId: 'g1',
    channelId: 'c1',
    options: {
      getString: (name) => ({ 소환사명: gameName, 태그: tagLine }[name] ?? null),
      getSubcommand: () => '실시간',
    },
    edits: [],
    replies: [],
    deferred: false,
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.edits.push(payload);
      return { id: 'msg1' };
    },
    async reply(payload) {
      this.replies.push(payload);
    },
  };
}

test('14. /전적 실시간: 로딩 → 기본 정보 → 사실 기반 결과 → (AI 성공 시) 설명 반영 순서로 응답하고 승리 확률을 만들지 않는다', async () => {
  const world = buildWorld(LINEUP);
  installRiot({ ...world, account: { puuid: 'p-blue-mid', gameName: '테스트', tagLine: 'KR1' } });
  installDdragon();
  process.env.LIVE_BRIEFING_AI = 'on';
  explainer.__testing.setClientFactory(() => ({
    messages: {
      create: async (body) => {
        const items = JSON.parse(body.messages[0].content.split('\n').pop()).items;
        return { content: [{ type: 'text', text: JSON.stringify({ items: items.map((i) => ({ id: i.id, text: `다듬은 문장 ${i.id.slice(1) ? '' : ''}`.trim() })) }) }] };
      },
    },
  }));

  const interaction = fakeCommandInteraction();
  await lolCommand.execute(interaction);
  assert.equal(interaction.deferred, true);
  assert.ok(interaction.edits.length >= 4, `edits ${interaction.edits.length}`);
  assert.match(allEmbedText(interaction.edits[0]), /현재 게임을 찾는 중/);
  assert.match(allEmbedText(interaction.edits[1]), /브리핑 준비 중/);

  const factual = interaction.edits[2];
  const factualText = allEmbedText(factual);
  assert.match(factualText, /AI 문장 다듬는 중/);
  assert.match(factualText, /내 포지션/);
  assert.match(factualText, /데이터 완성도/);
  assert.doesNotMatch(factualText, /승리 예측|승리 확률|승률 예측/);
  assert.ok(factual.components.length === 2);

  const final = interaction.edits[interaction.edits.length - 1];
  assert.match(allEmbedText(final), /다듬은 문장/);
  assert.match(allEmbedText(final), /AI가 검증된 사실을 다듬음/);

  // 같은 사용자의 연속 조회는 쿨다운
  const again = fakeCommandInteraction();
  await lolCommand.execute(again);
  assert.equal(again.replies[0].ephemeral, true);
  assert.match(again.replies[0].content, /초 후에 다시/);
});

test('14-2. 게임 중이 아니면 기존 최근 1게임 대체 흐름을 유지하고, 조회 실패는 분류된 메시지로 끝난다', async () => {
  // 게임 중이 아님은 오류가 아니라 notInGame으로 돌려주고, lol.js는 기존 최근 1게임 대체 흐름을 탄다
  const calls = installRiot({ live: null });
  const notInGame = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });
  assert.equal(notInGame.notInGame, true);
  assert.equal(calls.rank.length + calls.ids.length + calls.detail.length, 0);

  resetAll();
  installRiot({ account: 'notFound' });
  await assert.rejects(service.createLiveBriefing({ gameName: 'a', tagLine: 'b' }), (err) => err.code === 'ACCOUNT_NOT_FOUND');

  resetAll();
  installRiot({ live: () => { throw httpError(403); } });
  await assert.rejects(service.createLiveBriefing({ gameName: 'a', tagLine: 'b' }), (err) => err.code === 'AUTH');

  resetAll();
  installRiot({ live: () => { throw httpError(403); } });
  const interaction = fakeCommandInteraction({ userId: 'u-err' });
  await lolCommand.execute(interaction);
  const last = allEmbedText(interaction.edits[interaction.edits.length - 1]);
  assert.match(last, /실시간 게임 조회 실패/);
  assert.match(last, /인증 또는 권한/);
  assert.doesNotMatch(last, /test-riot-key/);

  // 자동 게임 감지(트래커)가 쓰는 기존 함수는 그대로 남아 있다
  assert.equal(typeof ORIGINAL_RIOT.fetchLiveGameData, 'function');
  assert.equal(typeof require(SRC('services', 'lolAnalyzer.js')).analyzeLiveGame, 'function');
  assert.equal(typeof require(SRC('services', 'matchLayoutService.js')).buildLiveGameLayout, 'function');

  // 슬래시 명령 정의(서브커맨드 이름·설명)는 바뀌지 않았다 → 재등록 불필요
  const json = lolCommand.data.toJSON();
  const live = json.options.find((o) => o.name === '실시간');
  assert.equal(live.description, '실시간 게임 정보를 AI로 분석합니다');
  assert.deepEqual(json.options.map((o) => o.name), ['등록', '해제', '목록', '채널설정', '실시간', '최근전적', '승부예측']);
});
