'use strict';

// /전적 실시간 테스트.
// 실제 Riot API·Data Dragon·Puppeteer·Discord 없이 riotService 함수와 HTTP·이미지 렌더를 가짜로 바꿔 실행한다.
// 아래 소환사·경기는 모두 테스트 데이터다.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadWithMocks } = require('./helpers/load-with-mocks');

const ROOT = path.resolve(__dirname, '..');
const SRC = (...p) => path.join(ROOT, 'src', ...p);

process.env.RIOT_API_KEY = 'test-riot-key';
delete process.env.LIVE_BRIEFING_LOOKBACK_DAYS;
delete process.env.LIVE_BRIEFING_MAX_GAMES;

const riotService = require(SRC('services', 'riotService.js'));
const knowledge = require(SRC('services', 'championKnowledgeService.js'));
const imageService = require(SRC('services', 'imageService.js'));
const analysis = require(SRC('services', 'liveBriefingAnalysis.js'));
const service = require(SRC('services', 'liveBriefingService.js'));
const { buildLiveGameView } = require(SRC('services', 'liveGameView.js'));
const card = require(SRC('services', 'liveGameCard.js'));
const layout = require(SRC('services', 'liveGameLayout.js'));
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
  103: { dataId: 'Ahri', name: '아리', lean: 'magic' },
  222: { dataId: 'Jinx', name: '징크스', lean: 'physical' },
  89: { dataId: 'Leona', name: '레오나', lean: 'mixed' },
  122: { dataId: 'Darius', name: '다리우스', lean: 'physical' },
  104: { dataId: 'Graves', name: '그레이브즈', lean: 'physical' },
  238: { dataId: 'Zed', name: '제드', lean: 'physical' },
  51: { dataId: 'Caitlyn', name: '케이틀린', lean: 'physical' },
  99: { dataId: 'Lux', name: '럭스', lean: 'magic' },
  1: { dataId: 'Annie', name: '애니', lean: 'magic' },
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
    gameStartTime: NOW - 11 * 60 * 1000,
    bannedChampions: [
      { championId: 1, teamId: 100, pickTurn: 1 },
      { championId: -1, teamId: 200, pickTurn: 2 },
    ],
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
      gameDuration: 1800,
      gameEndTimestamp: g.endMs ?? NOW - DAY,
      endOfGameResult: g.endOfGameResult ?? 'GameComplete',
      participants: [
        {
          puuid,
          teamId: 100,
          championId: g.championId,
          win: g.win ?? true,
          kills: g.kills ?? 5,
          deaths: g.deaths ?? 3,
          assists: g.assists ?? 7,
          goldEarned: 11000,
          teamPosition: g.teamPosition ?? '',
          gameEndedInEarlySurrender: g.remake === true,
        },
        { puuid: `${puuid}-other`, teamId: 200, championId: 1, win: !(g.win ?? true), kills: 1, deaths: 1, assists: 1, goldEarned: 9000, teamPosition: 'TOP' },
      ],
    },
  };
}

/** 참가자마다 count개의 경기를 만든다. champGames개는 현재 챔피언, 나머지는 다른 챔피언 (포지션은 main 역할) */
function buildWorld(lineup, { count = 20, champGames = 5 } = {}) {
  const ids = {};
  const details = {};
  for (const p of lineup) {
    if (!p.puuid) continue;
    const games = Array.from({ length: count }, (_, i) => ({
      championId: i < champGames ? p.championId : 1,
      teamPosition: p.role,
      win: i % 3 !== 0,
      endMs: NOW - (i + 1) * 60 * 60 * 1000,
    }));
    ids[p.puuid] = games.map((_, i) => `KR_${p.puuid}_${i}`);
    games.forEach((g, i) => {
      const id = ids[p.puuid][i];
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
const ORIGINAL_RENDER = imageService.renderHtmlToPng;

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
  detailErrors = {},
  masteries = {},
  detailDelayMs = 0,
} = {}) {
  const calls = { account: 0, live: 0, rank: [], ids: [], detail: [], mastery: [] };
  Object.assign(riotService, {
    initStaticData: async () => {},
    getStaticDataInfo: () => ({ version: '16.19.1', updatedAt: '2026-09-27T00:00:00.000Z' }),
    getChampionName: (id) => CHAMPS[id]?.name || `챔피언(${id})`,
    getChampionDataId: (id) => CHAMPS[id]?.dataId || null,
    getSpellName: (id) => ({ [FLASH]: '점멸', [SMITE]: '강타', [IGNITE]: '점화' }[id] || `스펠(${id})`),
    getSpellDataId: (id) => ({ [FLASH]: 'SummonerFlash', [SMITE]: 'SummonerSmite', [IGNITE]: 'SummonerDot' }[id] || null),
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
    async getTopChampionMasteries(puuid) {
      calls.mastery.push(puuid);
      if (Object.prototype.hasOwnProperty.call(masteries, puuid)) return masteries[puuid];
      return [{ championId: 103, championPoints: 250000, championLevel: 30 }, { championId: 238, championPoints: 90000, championLevel: 12 }];
    },
    async getRecentMatchIds(puuid, count, options) {
      calls.ids.push({ puuid, count, options });
      return ids[puuid] || [];
    },
    async getMatchDetail(matchId, options = {}) {
      calls.detail.push(matchId);
      await wait(detailDelayMs, options.signal);
      if (detailErrors[matchId]) throw detailErrors[matchId];
      return Object.prototype.hasOwnProperty.call(details, matchId) ? details[matchId] : null;
    },
  });
  return calls;
}

function installDdragon() {
  knowledge.__testing.setHttpGet(async (url) => {
    if (url.endsWith('runesReforged.json')) {
      return [{ id: 8100, name: '지배', icon: 'perk-images/Styles/7200_Domination.png', slots: [{ runes: [{ id: 8112, name: '감전', icon: 'perk-images/Styles/Domination/Electrocute/Electrocute.png' }] }] }];
    }
    const dataId = url.match(/champion\/([A-Za-z]+)\.json$/)[1];
    const c = Object.values(CHAMPS).find((x) => x.dataId === dataId);
    const info = { physical: { attack: 8, magic: 2 }, magic: { attack: 2, magic: 8 }, mixed: { attack: 5, magic: 5 } }[c.lean];
    return { data: { [dataId]: { id: dataId, name: c.name, tags: [], info } } };
  });
}

function resetAll() {
  Object.assign(riotService, ORIGINAL_RIOT);
  imageService.renderHtmlToPng = ORIGINAL_RENDER;
  service.__testing.reset();
  knowledge.__testing.reset();
}

test.beforeEach(resetAll);
test.after(() => {
  Object.assign(riotService, ORIGINAL_RIOT);
  imageService.renderHtmlToPng = ORIGINAL_RENDER;
  knowledge.__testing.reset();
});

async function modelFor(targetPuuid, riotOptions = {}, worldOptions = {}) {
  const world = buildWorld(riotOptions.lineup || LINEUP, worldOptions);
  const calls = installRiot({ ...world, account: { puuid: targetPuuid, gameName: '테스트', tagLine: 'KR1' }, ...riotOptions });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: '테스트', tagLine: 'KR1' });
  return { model, calls, world };
}

function allText(payload) {
  const walk = (c) => {
    const d = c.toJSON ? c.toJSON() : c;
    return [d.content || '', ...(d.components || []).map(walk)].join('\n');
  };
  return [
    ...payload.components.map(walk),
    ...(payload.embeds || []).map((e) => [e.data.title, e.data.description].join('\n')),
  ].join('\n');
}

// ============================================
// 1. 블루·레드 어디서 조회해도 내 팀·상대가 맞다
// ============================================
test('1. 조회 대상이 블루/레드일 때 PUUID로 우리 팀·상대 팀·내 챔피언·맞라인을 연결한다', async () => {
  const blue = await modelFor('p-blue-mid');
  const b = analysis.buildPerspective(blue.model);
  assert.equal(b.mode, 'personal');
  assert.equal(b.target.championName, '아리');
  assert.equal(b.allyTeamId, 100);
  assert.deepEqual(b.lane.opponents.map((p) => p.championName), ['제드']);
  assert.equal(b.myRole.role, 'MIDDLE');
  const blueView = buildLiveGameView(blue.model);
  assert.equal(blueView.teams.find((t) => t.teamId === 100).isAlly, true);
  assert.equal(blueView.teams.find((t) => t.teamId === 200).isAlly, false);

  resetAll();
  const red = await modelFor('p-red-mid');
  const r = analysis.buildPerspective(red.model);
  assert.equal(r.target.championName, '제드');
  assert.equal(r.allyTeamId, 200);
  assert.deepEqual(r.lane.opponents.map((p) => p.championName), ['아리']);
  const redView = buildLiveGameView(red.model);
  assert.equal(redView.teams.find((t) => t.teamId === 200).isAlly, true);
  assert.match(allText(layout.renderLiveGameMessage(redView)), /레드 팀 · 우리 팀/);
  // 조회 대상 행에 ⭐
  assert.match(allText(layout.renderLiveGameMessage(redView)), /제드\*\* `G2` 이름 정보 없음 ⭐/);
});

// ============================================
// 2. PUUID 불일치·비공개 참가자
// ============================================
test('2. 조회 대상이 참가자에 없으면 우리 팀 표시를 하지 않고, 비공개 참가자는 Riot 조회 없이 챔피언만 쓴다', async () => {
  const lineup = LINEUP.map((p) => (p.puuid === 'p-blue-mid' ? { ...p, puuid: null } : p));
  const world = buildWorld(lineup);
  const calls = installRiot({ ...world, live: liveGameFrom(lineup), account: { puuid: 'p-blue-mid', gameName: 'x', tagLine: 'y' } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'x', tagLine: 'y' });
  const view = buildLiveGameView(model);
  assert.equal(view.mode, 'general');
  assert.ok(view.teams.every((t) => !t.isAlly));
  // 역할 행은 그대로 맞대어 보여준다
  assert.equal(view.rows.length, 5);

  const hidden = model.participants.find((p) => p.championId === 103);
  assert.equal(hidden.rank.status, 'hidden');
  assert.equal(calls.rank.length, 9);
  assert.equal(calls.mastery.length, 9);

  const text = allText(layout.renderLiveGameMessage(view));
  assert.match(text, /참가자와 연결하지 못해/);
  assert.match(text, /\*\*미드\? · 아리\*\* `-` 비공개 참가자/);
  assert.doesNotMatch(text, /팀 · 우리 팀/);
});

// ============================================
// 3. 큐·기간 필터, 중복 제거, 빈 전적, 일부 실패
// ============================================
test('3. 동일 큐·기간으로 조회하고 중복 matchId를 제거하며, 정상 빈 전적과 일부 상세 실패를 구분한다', async () => {
  const world = buildWorld(LINEUP, { count: 6 });
  const mid = 'p-blue-mid';
  world.ids[mid] = [...world.ids[mid], world.ids[mid][0], world.ids[mid][1]];
  world.ids['p-red-mid'] = [];
  const failedId = world.ids['p-blue-top'][2];
  const calls = installRiot({ ...world, account: { puuid: mid, gameName: 'a', tagLine: 'b' }, detailErrors: { [failedId]: httpError(500) } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });

  const call = calls.ids.find((c) => c.puuid === mid);
  assert.equal(call.options.queue, 420);
  assert.equal(call.count, 20);
  assert.ok(Math.abs(call.options.startTime - Math.floor((Date.now() - 60 * DAY) / 1000)) < 5);

  const me = model.participants.find((p) => p.puuid === mid);
  assert.equal(me.stats.idsFound, 6);
  assert.equal(new Set(calls.detail.filter((id) => id.startsWith(`KR_${mid}_`))).size, 6);

  const view = buildLiveGameView(model);
  const emptyPlayer = view.rows.flatMap((r) => [r.left, r.right]).find((p) => p.championName === '제드');
  assert.match(layout.playerBlock(emptyPlayer, view.settings), /최근 60일 같은 큐 경기 없음/);

  const top = model.participants.find((p) => p.puuid === 'p-blue-top');
  assert.equal(top.stats.failed, 1);
  assert.equal(top.stats.collected, 5);

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
test('4. 챔피언 0경기·데스 0·중간 누락·다시하기를 규칙대로 처리한다', () => {
  const entry = (matchId, game) => ({ matchId, state: 'ok', game: { championId: 1, kills: 2, deaths: 0, assists: 3, teamPosition: 'MIDDLE', win: true, spy: false, ...game } });
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
  assert.equal(agg.winPermil, 667);
  assert.equal(analysis.formatKda(agg.kda), '데스 없음');
  assert.deepEqual(agg.streak, { win: true, count: 2, atLeast: true });
  assert.equal(agg.champion.games, 0);
  assert.deepEqual(agg.recent.map((g) => g.win), [true, true, false]);

  const remake = analysis.compactMatch(matchDetail('r', 'u', { championId: 1, remake: true }), 'r');
  assert.deepEqual(analysis.evaluateMatchFor(remake, 'u', { queueId: 420, cutoffMs: 0 }), { state: 'excluded', reason: 'remake' });
  assert.deepEqual(analysis.combinedKda(10, 4, 6), { deathless: false, hundredths: 400 });
});

// ============================================
// 5. 랭크 상태 구분
// ============================================
test('5. 정상 빈 랭크와 401/403/429/5xx/시간 초과/404가 서로 다른 상태로 남고, 실패는 캐시하지 않는다', async () => {
  const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true });
  const { model, calls } = await modelFor('p-blue-mid', {
    ranks: { 'p-blue-top': [], 'p-blue-jg': null },
    rankErrors: {
      'p-blue-adc': httpError(401),
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
  assert.deepEqual(rankOf('p-red-top'), { status: 'error', reason: 'rateLimited' });
  assert.deepEqual(rankOf('p-red-jg'), { status: 'error', reason: 'upstream' });
  assert.deepEqual(rankOf('p-red-mid'), { status: 'error', reason: 'timeout' });
  assert.equal(analysis.tierBadge(rankOf('p-blue-top')), 'U');
  assert.equal(analysis.tierBadge(rankOf('p-red-top')), '?');

  const view = buildLiveGameView(model);
  const text = allText(layout.renderLiveGameMessage(view));
  assert.match(text, /랭크 기록 없음/);
  assert.match(text, /랭크 조회 실패/);

  const before = calls.rank.length;
  await service.createLiveBriefing({ gameName: '테스트', tagLine: 'KR1' });
  const retried = calls.rank.slice(before);
  assert.ok(retried.includes('p-red-top'));
  assert.ok(!retried.includes('p-blue-mid'));
});

// ============================================
// 6. 역할 추정: 허위 확정 금지
// ============================================
function teamPlayer(slot, { positions = {}, champPositions = {}, smite = false } = {}) {
  const full = (obj) => ({ TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0, ...obj });
  return { slot, hasSmite: smite, stats: { positions: full(positions), champion: { positions: full(champPositions) } } };
}

test('6. 동점·강타 중복·근거 부족에서 포지션을 확정하지 않고, 화면 행 배치(slotRole)는 겹치지 않는다', () => {
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
  const slotRoles = [...t.values()].map((r) => r.slotRole);
  assert.equal(new Set(slotRoles).size, 5);

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

  const model = {
    game: { queueId: 450, mapId: 12 },
    targetPuuid: 'p-blue-mid',
    participants: LINEUP.map((p, slot) => ({ ...p, slot, championName: CHAMPS[p.championId].name, hasSmite: false, stats: null })),
  };
  const aram = analysis.buildPerspective(model);
  assert.equal(aram.roleSupported, false);
  assert.equal(aram.lane.type, 'none');
});

// ============================================
// 7. 태그: 라인꼬임·연승·장인·첩자주의
// ============================================
function statsWith(overrides = {}) {
  return {
    collected: 20,
    mainRole: null,
    streak: null,
    champion: { games: 0 },
    spy: { samples: 20, spies: 2, ratePermil: 100 },
    ...overrides,
  };
}

test('7. #라인꼬임은 주 포지션과 이번 판 추정 포지션이 다를 때, #라인꼬임?은 같은 팀 주 포지션이 겹칠 때만 붙는다', () => {
  const off = { stats: statsWith({ mainRole: 'MIDDLE' }) };
  assert.deepEqual(analysis.playerTags(off, { role: 'TOP', level: 'estimated' }, [off]).map((t) => t.text), ['#라인꼬임']);
  // 불확실한 추정으로는 #라인꼬임을 확정하지 않는다
  assert.deepEqual(analysis.playerTags(off, { role: null, slotRole: 'TOP', level: 'uncertain' }, [off]).map((t) => t.text), []);

  const a = { stats: statsWith({ mainRole: 'MIDDLE' }) };
  const b = { stats: statsWith({ mainRole: 'MIDDLE' }) };
  assert.deepEqual(analysis.playerTags(a, { role: null, slotRole: 'MIDDLE', level: 'uncertain' }, [a, b]).map((t) => t.text), ['#라인꼬임?']);

  const onMain = { stats: statsWith({ mainRole: 'TOP' }) };
  assert.deepEqual(analysis.playerTags(onMain, { role: 'TOP', level: 'estimated' }, [onMain]), []);

  const hot = { stats: statsWith({ streak: { win: true, count: 3, atLeast: false }, champion: { games: 12 }, spy: { samples: 10, spies: 5, ratePermil: 500 } }) };
  assert.deepEqual(analysis.playerTags(hot, null, [hot]).map((t) => t.text), ['#3연승', '#장인', '#첩자주의']);
  const cold = { stats: statsWith({ streak: { win: false, count: 4, atLeast: true } }) };
  assert.deepEqual(analysis.playerTags(cold, null, [cold]).map((t) => t.text), ['#4연패+']);
  assert.deepEqual(analysis.playerTags({ stats: statsWith({ streak: { win: true, count: 2, atLeast: false } }) }, null, []), []);

  // 주 포지션: 5경기 이상, 60% 이상
  const pos = (o) => ({ TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0, ...o });
  assert.equal(analysis.mainRoleOf(pos({ MIDDLE: 4 })), null);
  assert.equal(analysis.mainRoleOf(pos({ MIDDLE: 6, TOP: 4 })), 'MIDDLE');
  assert.equal(analysis.mainRoleOf(pos({ MIDDLE: 5, TOP: 5 })), null);
});

test('7-2. 실제 수집 흐름에서 주 포지션이 미드인 두 사람이 한 팀이면 #라인꼬임? 태그가 붙는다', async () => {
  const lineup = LINEUP.map((p) => (p.puuid === 'p-blue-adc' ? { ...p, role: 'MIDDLE' } : p));
  const { model } = await modelFor('p-blue-mid', { lineup, live: liveGameFrom(lineup) });
  const view = buildLiveGameView(model);
  const players = view.rows.flatMap((r) => [r.left, r.right]).filter(Boolean);
  const tagged = players.filter((p) => p.tags.some((t) => t.text.startsWith('#라인꼬임')));
  assert.deepEqual(tagged.map((p) => p.championName).sort(), ['아리', '징크스'].sort());
});

// ============================================
// 8. 첩자 판정률·팀 첩자 존재 확률
// ============================================
function fullMatch(puuid, me) {
  const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const participants = [];
  for (const teamId of [100, 200]) {
    roles.forEach((r) => {
      const isMe = teamId === 100 && r === 'MIDDLE';
      participants.push({
        puuid: isMe ? puuid : `${teamId}-${r}`,
        teamId,
        teamPosition: r,
        championId: 1,
        win: teamId === 100,
        kills: isMe ? me.kills : 4,
        deaths: isMe ? me.deaths : 4,
        assists: isMe ? me.assists : 5,
        goldEarned: isMe ? me.gold : 11000,
      });
    });
  }
  return analysis.compactMatch({ metadata: { matchId: 'M' }, info: { queueId: 420, gameDuration: 1800, gameEndTimestamp: NOW, endOfGameResult: 'GameComplete', participants } }, 'M');
}

test('8. 경기별 첩자 판정은 spyPrediction 점수식을 쓰고, 판정률·팀 존재 확률은 표본 기준을 지킨다', () => {
  const opts = { queueId: 420, cutoffMs: 0 };
  const bad = analysis.evaluateMatchFor(fullMatch('u', { kills: 0, deaths: 10, assists: 1, gold: 6000 }), 'u', opts);
  const good = analysis.evaluateMatchFor(fullMatch('u', { kills: 8, deaths: 2, assists: 9, gold: 14000 }), 'u', opts);
  assert.equal(bad.game.spy, true);
  assert.equal(good.game.spy, false);

  const entries = (verdicts) => ({
    ids: verdicts.map((_, i) => `m${i}`),
    entries: verdicts.map((spy, i) => ({ matchId: `m${i}`, state: 'ok', game: { championId: 1, kills: 1, deaths: 1, assists: 1, teamPosition: 'MIDDLE', win: true, spy } })),
  });
  assert.equal(analysis.aggregateHistory(entries([true, false, false, false]), 1).spy.ratePermil, null, '4판은 표본 부족');
  const five = analysis.aggregateHistory(entries([true, false, null, false, false, true]), 1).spy;
  assert.deepEqual(five, { samples: 5, spies: 2, ratePermil: 400 });

  const p = (slot, ratePermil) => ({ slot, stats: { spy: { ratePermil } } });
  // 1 − 0.8^4 = 0.5904
  assert.equal(analysis.teamSpyEstimate([p(0, 200), p(1, 200), p(2, 200), p(3, 200)]).permil, 590);
  // 조회 대상 본인(slot 0)은 뺀다
  const withMe = analysis.teamSpyEstimate([p(0, 900), p(1, 200), p(2, 200), p(3, 200), p(4, 200)], 0);
  assert.equal(withMe.permil, 590);
  assert.equal(withMe.expectedTenths, 8);
  assert.equal(analysis.teamSpyEstimate([p(1, 200), p(2, null), p(3, null)]).permil, null, '판정률 있는 사람 3명 미만');
});

// ============================================
// 9. 티어·평균 티어
// ============================================
test('9. 티어 배지·평균 티어는 랭크가 있는 사람만으로 계산한다', () => {
  const ranked = (tier, division, lp) => ({ rank: { status: 'ranked', tier, division, lp } });
  assert.equal(analysis.tierBadge(ranked('DIAMOND', 'I', 84).rank), 'D1');
  assert.equal(analysis.tierBadge(ranked('MASTER', 'I', 13).rank), 'M');
  assert.equal(analysis.tierBadge({ status: 'unranked' }), 'U');
  const avg = analysis.averageTier([ranked('DIAMOND', 'I', 50), ranked('DIAMOND', 'III', 50), { rank: { status: 'unranked' } }]);
  assert.equal(avg.label, '다이아몬드 II');
  assert.equal(avg.badge, 'D2');
  assert.equal(avg.counted, 2);
  assert.equal(avg.total, 3);
  assert.equal(analysis.averageTier([ranked('MASTER', 'I', 100), ranked('GRANDMASTER', 'I', 500)]).label, '마스터+');
  assert.equal(analysis.averageTier([{ rank: { status: 'error' } }]), null);
});

// ============================================
// 10·11. 공유 캐시와 사용자별 관점, 중복 호출 없음
// ============================================
test('10. 같은 경기를 다른 사용자가 조회하면 수집은 재사용하고 우리 팀 표시는 각자 기준이다', async () => {
  const world = buildWorld(LINEUP);
  let target = 'p-blue-mid';
  const calls = installRiot({ ...world });
  riotService.getAccountByRiotId = async (gameName, tagLine) => ({ puuid: target, gameName, tagLine });
  installDdragon();

  const first = await service.createLiveBriefing({ gameName: 'first', tagLine: 'KR1' });
  const detailsAfterFirst = calls.detail.length;
  const masteryAfterFirst = calls.mastery.length;
  target = 'p-red-top';
  const second = await service.createLiveBriefing({ gameName: 'second', tagLine: 'KR1' });

  assert.equal(calls.live, 2);
  const repeated = calls.detail.slice(detailsAfterFirst).filter((id) => calls.detail.indexOf(id) < detailsAfterFirst);
  assert.deepEqual(repeated, []);
  assert.equal(calls.mastery.length, masteryAfterFirst, '숙련도는 캐시');

  assert.equal(buildLiveGameView(first).teams.find((t) => t.isAlly).teamId, 100);
  assert.equal(buildLiveGameView(second).teams.find((t) => t.isAlly).teamId, 200);
});

test('11. 같은 경기 동시 조회에서 외부 호출이 중복으로 늘지 않는다', async () => {
  const world = buildWorld(LINEUP, { count: 8 });
  const calls = installRiot({ ...world, detailDelayMs: 5 });
  riotService.getAccountByRiotId = async (gameName, tagLine) => ({ puuid: gameName, gameName, tagLine });
  installDdragon();

  const [m1, m2] = await Promise.all([
    service.createLiveBriefing({ gameName: 'p-blue-mid', tagLine: 'KR1' }),
    service.createLiveBriefing({ gameName: 'p-red-mid', tagLine: 'KR1' }),
  ]);
  assert.equal(calls.detail.length, new Set(calls.detail).size);
  assert.equal(calls.ids.length, new Set(calls.ids.map((c) => c.puuid)).size);
  assert.equal(calls.mastery.length, new Set(calls.mastery).size);
  assert.equal(analysis.buildPerspective(m1).target.championName, '아리');
  assert.equal(analysis.buildPerspective(m2).target.championName, '제드');
});

// ============================================
// 12. 예산·기한·Retry-After
// ============================================
test('12. 요청당 새 경기 상세 상한과 기한을 지키고, 종료 후 남은 요청이 실행되지 않는다', async () => {
  const world = buildWorld(LINEUP, { count: 20 });
  const calls = installRiot({ ...world, account: { puuid: 'p-blue-mid', gameName: 'a', tagLine: 'b' } });
  installDdragon();
  const model = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });
  assert.ok(calls.detail.length <= service.LIVE_CONFIG.maxNewMatchDetails, `상세 ${calls.detail.length}개`);
  assert.equal(model.collectionStats.budgetHit, true);
  assert.equal(model.participants.find((p) => p.puuid === 'p-blue-mid').stats.collected, 20);
  assert.equal(model.participants.find((p) => p.puuid === 'p-red-mid').stats.collected, 20);
  assert.match(allText(layout.renderLiveGameMessage(buildLiveGameView(model))), /건 미수집/);

  resetAll();
  const slowWorld = buildWorld(LINEUP, { count: 20 });
  const slowCalls = installRiot({ ...slowWorld, account: { puuid: 'p-blue-mid', gameName: 'a', tagLine: 'b' }, detailDelayMs: 40 });
  installDdragon();
  const started = Date.now();
  const partial = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' }, { deadlineMs: 400 });
  assert.ok(Date.now() - started < 700);
  assert.ok(partial.participants.reduce((s, p) => s + (p.stats?.pending || 0), 0) > 0);
  const countAtReturn = slowCalls.detail.length;
  await sleep(150);
  assert.equal(slowCalls.detail.length, countAtReturn, '기한 후 새 요청 없음');
  assert.equal(service.__testing.caches.inflight.match.size, 0);
});

test('12-2. 공통 Riot 큐는 429 Retry-After를 지키고, 기한이 끝나면 대기 중인 호출자를 즉시 풀어준다', async () => {
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
  assert.deepEqual(await riot.getLeagueEntriesByPuuid('puuid-x'), []);
  assert.ok(attempts[1] - attempts[0] >= 950, 'Retry-After 1초 대기');

  attempts.length = 0;
  const controller = new AbortController();
  const p = riot.getLeagueEntriesByPuuid('puuid-y', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const t1 = Date.now();
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.ok(Date.now() - t1 < 500);
  await sleep(1100);
});

// ============================================
// 13. 화면: Components V2·이미지·길이·이스케이프
// ============================================
test('13. 메시지는 Components V2로 헤더·카드 이미지·블루/레드 컨테이너를 만들고, 이미지가 없어도 텍스트로 완결된다', async () => {
  const { model } = await modelFor('p-blue-mid');
  const view = buildLiveGameView(model);

  const withImage = layout.renderLiveGameMessage(view, { image: Buffer.from('png') });
  assert.equal(withImage.flags, 1 << 15);
  assert.deepEqual(withImage.embeds, []);
  assert.equal(withImage.content, '');
  assert.equal(withImage.files.length, 1);
  assert.equal(withImage.files[0].name, 'live-game.png');
  const header = withImage.components[0].toJSON();
  assert.ok(header.components.some((c) => c.type === 12 && c.items[0].media.url === 'attachment://live-game.png'));
  assert.deepEqual(withImage.allowedMentions, { parse: [] });

  const textOnly = layout.renderLiveGameMessage(view, { image: null });
  assert.equal(textOnly.files.length, 0);
  const text = allText(textOnly);
  assert.match(text, /🔴 LIVE · 11분 경과 · 솔로랭크 · 소환사의 협곡/);
  assert.match(text, /🔵 블루 팀 · 우리 팀/);
  assert.match(text, /평균 골드 II \(5\/5명\)/);
  assert.match(text, /밴 애니/);
  assert.match(text, /시즌 54\.5% \(55판\)/);
  assert.match(text, /주챔 아리·제드/);
  assert.match(text, /🕵️ 첩자/);
  assert.doesNotMatch(text, /승리 확률|승률 예측/);
  // 라인 순서: 탑 → 서포터
  const blueBody = textOnly.components[1].toJSON().components[2].content;
  const order = ['탑', '정글', '미드', '원딜', '서포터'].map((r) => blueBody.indexOf(`**${r} · `));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), blueBody);
});

test('13-2. 긴 이름·멘션·HTML이 있어도 4000자 제한과 이스케이프를 지킨다', async () => {
  const lineup = LINEUP.map((p) => ({ ...p, riotId: `@everyone <b>굵게</b> **별표** ${'긴이름'.repeat(40)}#KR1` }));
  const { model } = await modelFor('p-blue-mid', { lineup, live: liveGameFrom(lineup) });
  const view = buildLiveGameView(model);
  const payload = layout.renderLiveGameMessage(view, { image: Buffer.from('png') });
  assert.ok(layout.totalTextLength(payload) <= 4000, `${layout.totalTextLength(payload)}자`);
  const text = allText(payload);
  assert.doesNotMatch(text, /@everyone/);
  assert.match(text, /\\\*\\\*별표/);

  const html = card.buildLiveGameCardHtml(view);
  assert.doesNotMatch(html, /<b>굵게<\/b>/);
  assert.match(html, /&lt;b&gt;굵게&lt;\/b&gt;/);
  // 이미지는 Data Dragon 주소만
  const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 20);
  assert.ok(srcs.every((s) => s.startsWith('https://ddragon.leagueoflegends.com/')));
  assert.match(html, /첩자일 확률/);
  assert.match(html, /LIVE/);
});

test('13-3. 카드 HTML 렌더는 공용 브라우저를 쓰고, 외부 이미지 대기 시간 초과에도 찍는다', async () => {
  const shots = [];
  let launches = 0;
  const browser = {
    connected: true,
    async newPage() {
      return {
        async setViewport(v) { shots.push(['viewport', v.height]); },
        async setContent() { const e = new Error('Navigation timeout'); e.name = 'TimeoutError'; throw e; },
        async evaluate() { return 900; },
        async screenshot(opts) { shots.push(['shot', opts.type]); return Buffer.from('png'); },
        async close() {},
      };
    },
    async close() { this.connected = false; },
  };
  const service2 = loadWithMocks(SRC('services', 'imageService.js'), { puppeteer: { launch: async () => { launches++; return browser; } } });
  const out = await service2.renderHtmlToPng('<html></html>', { width: 1100, timeoutMs: 10 });
  assert.equal(out.toString(), 'png');
  assert.deepEqual(shots.at(-1), ['shot', 'png']);
  assert.ok(shots.some(([k, h]) => k === 'viewport' && h === 900));
  await service2.renderHtmlToPng('<html></html>');
  assert.equal(launches, 1);
  await service2.closeBrowser();
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
    async deferReply() { this.deferred = true; },
    async editReply(payload) { this.edits.push(payload); return { id: 'msg1' }; },
    async reply(payload) { this.replies.push(payload); },
  };
}

test('14. /전적 실시간: 로딩 → 기본 정보 → 카드 이미지+팀 컨테이너 순서로 응답하고, 이미지 실패 시 텍스트로 끝낸다', async () => {
  const world = buildWorld(LINEUP);
  installRiot({ ...world, account: { puuid: 'p-blue-mid', gameName: '테스트', tagLine: 'KR1' } });
  installDdragon();
  const htmls = [];
  imageService.renderHtmlToPng = async (html) => { htmls.push(html); return Buffer.from('png'); };

  const interaction = fakeCommandInteraction();
  await lolCommand.execute(interaction);
  assert.equal(interaction.deferred, true);
  assert.equal(interaction.edits.length, 3);
  assert.match(interaction.edits[0].embeds[0].data.title, /현재 게임을 찾는 중/);
  assert.match(interaction.edits[1].embeds[0].data.title, /실시간 게임 분석 중/);
  const final = interaction.edits[2];
  assert.equal(final.flags, 1 << 15);
  assert.equal(final.files.length, 1);
  assert.equal(htmls.length, 1);
  assert.match(allText(final), /블루 팀 · 우리 팀/);

  // 같은 사용자 연속 조회는 쿨다운
  const again = fakeCommandInteraction();
  await lolCommand.execute(again);
  assert.match(again.replies[0].content, /초 후에 다시/);

  // 이미지 생성 실패 → 텍스트만
  service.__testing.reset();
  imageService.renderHtmlToPng = async () => { throw new Error('chromium 없음'); };
  const noImage = fakeCommandInteraction({ userId: 'u2' });
  await lolCommand.execute(noImage);
  const last = noImage.edits.at(-1);
  assert.equal(last.files.length, 0);
  assert.match(allText(last), /레드 팀/);
});

test('14-2. 게임 중이 아니면 기존 최근 1게임 대체 흐름을 유지하고, 조회 실패는 분류된 메시지로 끝난다', async () => {
  const calls = installRiot({ live: null });
  const notInGame = await service.createLiveBriefing({ gameName: 'a', tagLine: 'b' });
  assert.equal(notInGame.notInGame, true);
  assert.equal(calls.rank.length + calls.ids.length + calls.detail.length + calls.mastery.length, 0);

  resetAll();
  installRiot({ account: 'notFound' });
  await assert.rejects(service.createLiveBriefing({ gameName: 'a', tagLine: 'b' }), (err) => err.code === 'ACCOUNT_NOT_FOUND');

  resetAll();
  installRiot({ live: () => { throw httpError(403); } });
  const interaction = fakeCommandInteraction({ userId: 'u-err' });
  await lolCommand.execute(interaction);
  const last = allText(interaction.edits.at(-1));
  assert.match(last, /실시간 게임 조회 실패/);
  assert.match(last, /인증 또는 권한/);
  assert.doesNotMatch(last, /test-riot-key/);

  // 자동 게임 감지(트래커)가 쓰는 기존 함수는 그대로 남아 있다
  assert.equal(typeof ORIGINAL_RIOT.fetchLiveGameData, 'function');
  assert.equal(typeof require(SRC('services', 'lolAnalyzer.js')).analyzeLiveGame, 'function');
  assert.equal(typeof require(SRC('services', 'matchLayoutService.js')).buildLiveGameLayout, 'function');

  // 슬래시 명령 정의는 바뀌지 않았다 → 재등록 불필요
  const json = lolCommand.data.toJSON();
  assert.equal(json.options.find((o) => o.name === '실시간').description, '실시간 게임 정보를 AI로 분석합니다');
  assert.deepEqual(json.options.map((o) => o.name), ['등록', '해제', '목록', '채널설정', '실시간', '최근전적', '승부예측']);
});
