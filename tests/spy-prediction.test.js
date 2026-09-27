'use strict';

// 🕵️ 메튜렁의 첩자 테스트. 실제 Riot API·Discord·DB 없이 실행한다.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadWithMocks } = require('./helpers/load-with-mocks');
const spy = require('../src/services/spyPrediction');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_PATH = path.join(ROOT, 'src', 'services', 'lolPredictionService.js');
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const ME = 'puuid-me';
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// 부진/양호 아군 성적 (score 약 75 / 13)
const BAD = { kills: 0, deaths: 9, assists: 2, goldEarned: 7000 };
const GOOD = { kills: 5, deaths: 2, assists: 8, goldEarned: 12000 };

// 원본 Riot 형식 participants (나 = UTILITY, 아군 4명 중 앞 spies명이 부진)
function participants(win, spies) {
  const list = [{ puuid: ME, teamId: 100, win, teamPosition: 'UTILITY', kills: 2, deaths: 3, assists: 10, goldEarned: 9000 }];
  POSITIONS.slice(0, 4).forEach((position, i) => {
    list.push({ puuid: `ally-${i}`, teamId: 100, win, teamPosition: position, ...(i < spies ? BAD : GOOD) });
  });
  POSITIONS.forEach((position, i) => {
    list.push({ puuid: `enemy-${i}`, teamId: 200, win: !win, teamPosition: position, kills: 4, deaths: 4, assists: 4, goldEarned: 11000 });
  });
  return list;
}

// 순수 함수용 게임 (compactMatch 결과와 같은 모양)
function game(win, spies) {
  return { win, match: { gameDuration: 1800, players: participants(win, spies) } };
}

function riotDetail(id, i, { win, spies, gameDuration = 1800, list }) {
  return {
    metadata: { matchId: id },
    info: {
      queueId: 420,
      platformId: 'KR',
      gameDuration,
      gameEndTimestamp: NOW - (i + 1) * HOUR,
      endOfGameResult: 'GameComplete',
      participants: list || participants(win, spies),
    },
  };
}

function riotMock(specs, extra = {}) {
  const ids = specs.map((_, i) => `KR_${100 - i}`);
  const details = Object.fromEntries(specs.map((s, i) => [ids[i], riotDetail(ids[i], i, s)]));
  const calls = { list: 0, detail: 0 };
  return {
    calls,
    mock: {
      async getRecentMatchIds() {
        calls.list++;
        if (extra.listError) throw extra.listError;
        return ids;
      },
      async getMatchDetail(id) {
        calls.detail++;
        if (extra.detailErrors?.[id]) throw extra.detailErrors[id];
        return details[id] ?? null;
      },
      async getAccountByRiotId() {
        throw Object.assign(new Error('없음'), { notFound: true });
      },
    },
    ids,
    details,
  };
}

function loadService(mock) {
  const service = loadWithMocks(SERVICE_PATH, { './riotService': mock });
  service.__testing.reset();
  service.__testing.setNow(() => NOW);
  return service;
}

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, headers: {} },
  });
}

function assertValidPrediction(result) {
  assert.equal(result.insufficient, false);
  const { distribution, percents } = result;
  assert.equal(distribution.length, 4);
  for (const p of distribution) assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `p=${p}`);
  assert.ok(Math.abs(distribution.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(percents.reduce((a, b) => a + b, 0), 100);
  for (const p of percents) assert.ok(Number.isInteger(p) && p >= 0 && p <= 100);
  assert.equal(result.existProbability, 1 - distribution[0]);
  assert.equal(result.existPercent, 100 - percents[0]);
  assert.ok(Number.isFinite(result.expectedCount) && result.expectedCount >= 0 && result.expectedCount <= 3);
}

// ============================================
// 점수
// ============================================
test('spyScore: 부진한 아군은 threshold 이상, 양호한 아군은 미만이며 10~90 범위를 벗어나지 않는다', () => {
  const base = { teamKills: 20, durationSec: 1800, laneOpponentGold: 11000 };
  const bad = spy.calculateSpyScore({ ...base, ...BAD, gold: BAD.goldEarned });
  const good = spy.calculateSpyScore({ ...base, ...GOOD, gold: GOOD.goldEarned });
  assert.ok(bad >= spy.SPY_CONFIG.scoreThreshold, `bad=${bad}`);
  assert.ok(good < spy.SPY_CONFIG.scoreThreshold, `good=${good}`);

  const worst = spy.calculateSpyScore({ ...base, kills: 0, deaths: 30, assists: 0, gold: 0 });
  const best = spy.calculateSpyScore({ ...base, kills: 20, deaths: 0, assists: 0, gold: 50000 });
  assert.equal(worst, 90);
  assert.equal(best, 10);

  // 선택 항목이 없어도 가중치를 다시 나눠 계산하고, 필수 값이 이상하면 null
  const kdaOnly = spy.calculateSpyScore({ kills: 1, deaths: 1, assists: 1 });
  assert.ok(Number.isFinite(kdaOnly));
  for (const broken of [{}, { kills: 1, deaths: -1, assists: 0 }, { kills: NaN, deaths: 1, assists: 1 }, { kills: '1', deaths: 1, assists: 1 }]) {
    assert.equal(spy.calculateSpyScore(broken), null);
  }
});

test('경기별 첩자 수: 아군 4명만 세고, 판단 불가 아군이 있으면 그 경기는 null', () => {
  for (let spies = 0; spies <= 4; spies++) {
    assert.equal(spy.countSpiesInMatch(game(true, spies).match, ME), spies);
  }
  const broken = game(true, 1).match;
  broken.players[2] = { ...broken.players[2], deaths: undefined };
  assert.equal(spy.countSpiesInMatch(broken, ME), null);
  const missingAlly = game(true, 1).match;
  missingAlly.players.splice(1, 1);
  assert.equal(spy.countSpiesInMatch(missingAlly, ME), null);
  assert.equal(spy.countSpiesInMatch(game(true, 1).match, 'stranger'), null);
});

test('분포·기대값·정수 % 변환 예시', () => {
  const samples = [...Array(5).fill(0), ...Array(8).fill(1), ...Array(5).fill(2), 3, 4];
  const distribution = spy.calculateSpyDistribution(samples);
  assert.deepEqual(distribution, [0.25, 0.4, 0.25, 0.1]);
  assert.ok(Math.abs(spy.calculateExpectedSpyCount(distribution) - 1.2) < 1e-12);
  assert.deepEqual(spy.toWholePercents([1 / 3, 1 / 3, 1 / 3, 0]), [34, 33, 33, 0]);
  assert.equal(spy.calculateSpyDistribution([]), null);
});

test('경기 시작 직전 연승/연패 계산과 표본 끝 truncated 표시', () => {
  const results = [true, true, false, false, false];
  assert.deepEqual(spy.streakBefore(results, -1), { win: true, count: 2, truncated: false });
  assert.deepEqual(spy.streakBefore(results, 0), { win: true, count: 1, truncated: false });
  assert.deepEqual(spy.streakBefore(results, 1), { win: false, count: 3, truncated: true });
  assert.equal(spy.streakBefore(results, 4), null);
});

// ============================================
// 표본 선택 (14절 1~7)
// ============================================
test('1·3. 충분한 데이터 + 연승 중: 비슷한 연승(±1) 상태 경기만으로 분포를 만든다', () => {
  // 최신순 "W W L" 반복: 현재 2연승, 시작 직전 1~2연승이었던 경기가 많다
  const results = Array.from({ length: 33 }, (_, i) => i % 3 !== 2);
  const games = results.map((win, i) => game(win, i % 2 === 0 ? 1 : 2));
  const result = spy.calculateSpyPrediction(games, ME);
  assertValidPrediction(result);
  assert.equal(result.stage, 1);
  assert.equal(result.condition, '1~3연승 상태에서 시작한 경기');

  const expected = games
    .map((g, i) => ({ spies: spy.countSpiesInMatch(g.match, ME), before: spy.streakBefore(results, i) }))
    .filter((c) => c.before && !c.before.truncated && c.before.win && c.before.count >= 1 && c.before.count <= 3);
  assert.equal(result.sampleSize, expected.length);
});

test('4. 연패 중: 연패 방향 표본을 쓰고 부족하면 단계적으로 완화한다', () => {
  // 현재 5연패. 최근 20경기 중 5~7연패로 시작한 경기는 거의 없고, 연패 중 시작한 경기도 10개 미만
  const results = [false, false, false, false, false, true, true, true, true, true, true, true, false, true, true, true, true, true, true, true];
  const games = results.map((win) => game(win, win ? 0 : 2));
  const result = spy.calculateSpyPrediction(games, ME);
  assertValidPrediction(result);
  assert.equal(result.stage, 3);
  assert.equal(result.condition, '최근 경기 전체');
  assert.equal(result.sampleSize, 20);
});

test('연승 자체로 첩자 수를 올리지 않는다: 같은 과거 첩자 수면 연승/연패와 무관하게 같은 분포', () => {
  for (const current of [true, false]) {
    const results = [current, current, current, ...Array.from({ length: 20 }, (_, i) => i % 2 === 0)];
    const result = spy.calculateSpyPrediction(results.map((win) => game(win, 1)), ME);
    assert.deepEqual(result.distribution, [0, 1, 0, 0]);
    assert.equal(result.expectedCount, 1);
  }
});

test('2. 데이터가 거의 없거나 판단 가능한 경기가 10개 미만이면 추정하지 않는다', () => {
  assert.deepEqual(spy.calculateSpyPrediction([], ME), { insufficient: true, eligibleGames: 0 });
  const nine = Array.from({ length: 9 }, (_, i) => game(i % 2 === 0, 1));
  assert.equal(spy.calculateSpyPrediction(nine, ME).insufficient, true);

  // 20경기라도 아군 데이터가 깨져 판단 가능한 경기가 9개면 부족
  const games = Array.from({ length: 20 }, (_, i) => game(i % 2 === 0, 1));
  for (const g of games.slice(9)) g.match.players[1].kills = undefined;
  const result = spy.calculateSpyPrediction(games, ME);
  assert.equal(result.insufficient, true);
  assert.equal(result.eligibleGames, 9);
});

test('5·6·7. 승률 약 50%/매우 높음/매우 낮음에서도 확률 불변식이 유지된다', () => {
  const patterns = {
    '50%': Array.from({ length: 20 }, (_, i) => i % 2 === 0),
    '90%': Array.from({ length: 20 }, (_, i) => i % 10 !== 5),
    '10%': Array.from({ length: 20 }, (_, i) => i % 10 === 5),
    '100%': Array(20).fill(true),
    '0%': Array(20).fill(false),
  };
  for (const [label, results] of Object.entries(patterns)) {
    const result = spy.calculateSpyPrediction(results.map((win, i) => game(win, i % 4)), ME);
    assertValidPrediction(result);
    assert.ok(result.sampleSize >= spy.SPY_CONFIG.minSampleSize, label);
  }
});

test('무작위 입력 500회: NaN·Infinity·음수·100% 초과 없음, 합계 100%, 존재 확률 = 1 - P(0명)', () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 500; trial++) {
    const n = 10 + Math.floor(random() * 31);
    const games = Array.from({ length: n }, () => game(random() < 0.5, Math.floor(random() * 5)));
    const result = spy.calculateSpyPrediction(games, ME);
    if (!result.insufficient) assertValidPrediction(result);
  }
});

// ============================================
// 서비스 연동 (14절 8~12) — 추가 API 호출 없음
// ============================================
test('승부예측 결과에 첩자 예측이 붙고, 추가 Riot 호출이 없으며 임베드 필드 하나로 표시된다', async () => {
  const specs = Array.from({ length: 20 }, (_, i) => ({ win: i % 2 === 0, spies: i % 3 }));
  const riot = riotMock(specs);
  const service = loadService(riot.mock);
  const result = await service.getPrediction(ME);

  assert.equal(riot.calls.list, 1);
  assert.equal(riot.calls.detail, 20, '승부예측과 같은 20경기 상세만 조회');
  assertValidPrediction(result.spy);

  const embed = service.buildPredictionEmbed({ ...result, gameName: 'A', tagLine: 'KR1' }).toJSON();
  assert.equal(embed.fields.length, 1);
  assert.equal(embed.fields[0].name, '🕵️ 메튜렁의 첩자');
  const value = embed.fields[0].value;
  assert.match(value, new RegExp(`첩자 존재 확률 \`${result.spy.existPercent}%\``));
  assert.match(value, /0명 \d+% · 1명 \d+% · 2명 \d+% · 3명\+ \d+%/);
  assert.match(value, /예상 첩자 수 `\d\.\d명`/);
  assert.match(value, /재미용 통계 예측/);
  assert.ok(value.length <= 1024);
  assert.doesNotMatch(value, /NaN|Infinity/);
});

test('11. 솔랭 기록이 없는 사용자(언랭크)는 첩자 영역에 데이터 부족을 표시한다', async () => {
  const service = loadService(riotMock([]).mock);
  const result = await service.getPrediction(ME);
  assert.equal(result.spy.insufficient, true);
  const embed = service.buildPredictionEmbed({ ...result, gameName: 'A', tagLine: 'KR1' }).toJSON();
  assert.match(embed.fields[0].value, /아직 예측에 필요한 경기 데이터가 부족합니다/);
  assert.doesNotMatch(embed.fields[0].value, /%/);
});

test('12. 다시하기·5분 미만 경기는 승부예측과 첩자 표본 모두에서 빠진다', async () => {
  const specs = Array.from({ length: 12 }, (_, i) => ({ win: i % 2 === 0, spies: 4 }));
  specs.splice(3, 0, { win: false, spies: 4, gameDuration: 200 }, { win: false, spies: 4, gameDuration: 299 });
  specs.push(...Array.from({ length: 2 }, () => ({ win: true, spies: 0 })));
  const service = loadService(riotMock(specs).mock);
  const result = await service.getPrediction(ME);
  assert.equal(result.sampleSize, 14);
  assert.equal(result.excluded.short, 2);
  assert.equal(result.spy.sampleSize, 14);
  assert.deepEqual(result.spy.percents, [14, 0, 0, 86]);
});

test('아군 데이터가 깨진 경기는 첩자 표본에서만 빠지고 승부예측은 그대로 계산된다', async () => {
  const specs = Array.from({ length: 12 }, (_, i) => ({ win: i % 2 === 0, spies: 1 }));
  specs[0].list = participants(true, 1).map((p) => (p.puuid === 'ally-2' ? { ...p, kills: null } : p));
  const service = loadService(riotMock(specs).mock);
  const result = await service.getPrediction(ME);
  assert.equal(result.sampleSize, 12);
  assert.equal(result.spy.sampleSize, 11);
});

test('8·9·10. 일부 요청 실패·429·상세 404는 부분 결과로 첩자 확률을 만들지 않고 요청 전체를 오류로 끝낸다', async () => {
  const specs = Array.from({ length: 20 }, (_, i) => ({ win: i % 2 === 0, spies: 1 }));
  const cases = [
    ['8. 상세 5xx', { detailErrors: { KR_95: httpError(503) } }, 'UPSTREAM'],
    ['9. 429', { detailErrors: { KR_90: httpError(429) } }, 'RATE_LIMITED'],
    ['9. 목록 429', { listError: httpError(429) }, 'RATE_LIMITED'],
  ];
  for (const [label, extra, code] of cases) {
    const service = loadService(riotMock(specs, extra).mock);
    const err = await service.getPrediction(ME).catch((e) => e);
    assert.equal(service.classifyPredictionError(err).code, code, label);
    assert.equal(service.__testing.caches.resultCache.size, 0, label);
  }

  const missing = riotMock(specs);
  delete missing.details.KR_97;
  const service404 = loadService(missing.mock);
  await assert.rejects(service404.getPrediction(ME), (err) => err.code === 'MATCH_NOT_FOUND');
});
