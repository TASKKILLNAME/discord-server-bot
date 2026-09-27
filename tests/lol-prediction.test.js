'use strict';

// /전적 승부예측 테스트. 실제 Riot API·Discord·DB 없이 모듈을 모킹해서 실행한다.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadWithMocks } = require('./helpers/load-with-mocks');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_PATH = path.join(ROOT, 'src', 'services', 'lolPredictionService.js');
const RIOT_PATH = path.join(ROOT, 'src', 'services', 'riotService.js');
const LOL_PATH = path.join(ROOT, 'src', 'commands', 'lol.js');

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const PUUID = 'puuid-target';

function detail(id, overrides = {}) {
  const {
    win = true,
    puuid = PUUID,
    queueId = 420,
    platformId = 'KR',
    gameDuration = 1800,
    gameEndTimestamp = NOW - DAY,
    endOfGameResult = 'GameComplete',
    participants,
    extraInfo = {},
  } = overrides;
  return {
    metadata: { matchId: id },
    info: {
      queueId,
      platformId,
      gameDuration,
      gameEndTimestamp,
      endOfGameResult,
      participants: participants || [
        { puuid, win },
        { puuid: 'other', win: !win },
      ],
      ...extraInfo,
    },
  };
}

// 최신순 결과 배열로 매치 상세 목록을 만든다 (index 0 = 최신)
function historyFrom(results) {
  const details = {};
  const ids = results.map((win, i) => {
    const id = `KR_${1000 - i}`;
    details[id] = detail(id, { win, gameEndTimestamp: NOW - (i + 1) * 60 * 60 * 1000 });
    return id;
  });
  return { ids, details };
}

function createRiotMock({ ids = [], details = {}, account, listError, detailErrors = {}, delayMs = 0 } = {}) {
  const calls = { list: [], detail: [], account: [] };
  const wait = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  return {
    calls,
    mock: {
      async getRecentMatchIds(puuid, count, options) {
        calls.list.push({ puuid, count, options });
        await wait();
        if (listError) throw listError;
        return ids;
      },
      async getMatchDetail(matchId, options) {
        calls.detail.push(matchId);
        await wait();
        if (options?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (detailErrors[matchId]) throw detailErrors[matchId];
        return Object.prototype.hasOwnProperty.call(details, matchId) ? details[matchId] : null;
      },
      async getAccountByRiotId(gameName, tagLine, options) {
        calls.account.push({ gameName, tagLine, options });
        if (!account) {
          const err = new Error('소환사를 찾을 수 없습니다.');
          err.userMessage = err.message;
          err.notFound = true;
          throw err;
        }
        return account;
      },
    },
  };
}

function loadService(riotMock) {
  const service = loadWithMocks(SERVICE_PATH, { './riotService': riotMock });
  service.__testing.reset();
  service.__testing.setNow(() => NOW);
  return service;
}

function httpError(status, headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.isAxiosError = true;
  err.response = { status, headers };
  err.config = { headers: { 'X-Riot-Token': 'RGAPI-SECRET' } };
  return err;
}

// ============================================
// 1. 계산
// ============================================
test('계산 예시와 표시 반올림이 명세와 같다', () => {
  const { computeEstimate, formatTenths } = loadService(createRiotMock().mock);
  const cases = [
    [20, 9, '47.5', '52.5'],
    [20, 10, '50.0', '50.0'],
    [20, 20, '75.0', '25.0'],
    [20, 0, '25.0', '75.0'],
    [5, 4, '56.0', '44.0'],
  ];
  for (const [n, w, win, loss] of cases) {
    const e = computeEstimate(n, w);
    assert.equal(formatTenths(e.winTenths), win, `${n}경기 ${w}승`);
    assert.equal(formatTenths(e.lossTenths), loss, `${n}경기 ${w}승`);
    assert.equal(e.winProbability, (w + 10) / (n + 20));
  }
  for (let n = 0; n <= 4; n++) {
    for (let w = 0; w <= n; w++) assert.equal(computeEstimate(n, w), null);
  }
  for (let n = 5; n <= 20; n++) {
    for (let w = 0; w <= n; w++) {
      const e = computeEstimate(n, w);
      assert.equal(e.winTenths + e.lossTenths, 1000);
      assert.ok(Math.abs(e.winTenths / 1000 - e.winProbability) <= 0.0005 + 1e-12);
      assert.deepEqual(computeEstimate(n, w), e, '같은 입력은 같은 결과');
    }
  }
  assert.throws(() => computeEstimate(5, 6), RangeError);
});

// ============================================
// 2. 최근 5경기·연승/연패
// ============================================
test('최근 5경기 집계와 최신순 연승·연패, 전 표본 동일 시 최소 표시', () => {
  const { summarizeResults } = loadService(createRiotMock().mock);

  const s = summarizeResults([false, false, false, true, false, true, true]);
  assert.deepEqual(s.recent, { games: 5, wins: 1, losses: 4 });
  assert.deepEqual(s.streak, { win: false, count: 3, atLeast: false });
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 4);

  assert.deepEqual(summarizeResults([true, true, true]).streak, { win: true, count: 3, atLeast: true });
  assert.deepEqual(summarizeResults([true, true, true]).recent, { games: 3, wins: 3, losses: 0 });
  assert.equal(summarizeResults([]).streak, null);
});

// ============================================
// 3. 필터
// ============================================
test('솔랭·한국 서버·기간 필터, 5분 미만 제외, 5분 이상 항복 포함, 중복 제거', async () => {
  const details = {
    KR_10: detail('KR_10', { win: true }),
    KR_9: detail('KR_9', { queueId: 440 }),
    KR_8: detail('KR_8', { platformId: 'JP1' }),
    KR_7: detail('KR_7', { gameDuration: 299, win: false }),
    KR_6: detail('KR_6', { gameDuration: 300, win: false, extraInfo: { gameEndedInSurrender: true } }),
    KR_5: detail('KR_5', { gameEndTimestamp: NOW - 91 * DAY }),
    KR_4: detail('KR_4', { endOfGameResult: 'Abort_Unexpected' }),
  };
  const ids = ['KR_10', 'KR_10', 'KR_9', 'KR_8', 'KR_7', 'KR_6', 'KR_5', 'KR_4'];
  const riot = createRiotMock({ ids, details });
  const service = loadService(riot.mock);

  const { games, excluded } = await service.collectRecentGames(PUUID);

  assert.equal(riot.calls.list.length, 1);
  const { count, options } = riot.calls.list[0];
  assert.equal(count, 40);
  assert.equal(options.queue, 420);
  assert.equal(options.startTime, Math.floor((NOW - 90 * DAY) / 1000));
  assert.deepEqual(games.map((g) => [g.matchId, g.win]), [['KR_10', true], ['KR_6', false]]);
  assert.deepEqual(excluded, { queue: 1, platform: 1, notCompleted: 1, period: 1, short: 1 });
  assert.equal(riot.calls.detail.filter((id) => id === 'KR_10').length, 1, '중복 ID는 한 번만 조회');
});

test('유효 20경기가 모이면 추가 상세 조회를 멈추고, 40개를 넘는 ID는 보지 않는다', async () => {
  const { ids, details } = historyFrom(Array.from({ length: 45 }, (_, i) => i % 2 === 0));
  const riot = createRiotMock({ ids, details });
  const service = loadService(riot.mock);

  const { games } = await service.collectRecentGames(PUUID);
  assert.equal(games.length, 20);
  assert.equal(riot.calls.detail.length, 20);

  // 전부 5분 미만이면 40개까지만 확인하고 멈춘다
  for (const id of ids) details[id].info.gameDuration = 100;
  service.__testing.reset();
  service.__testing.setNow(() => NOW);
  riot.calls.detail.length = 0;
  const shortOnly = await service.collectRecentGames(PUUID);
  assert.equal(shortOnly.games.length, 0);
  assert.equal(riot.calls.detail.length, 40);
});

// ============================================
// 4. 데이터 오류는 패배/정상 결과로 바꾸지 않는다
// ============================================
test('참가자 미확인·win 오류·상세 404·상세 5xx는 요청 전체를 오류로 처리하고 캐시하지 않는다', async () => {
  const scenarios = [
    ['참가자 없음', { participants: [{ puuid: 'someone', win: true }] }, 'INVALID_MATCH_DATA'],
    ['win 누락', { participants: [{ puuid: PUUID }] }, 'INVALID_MATCH_DATA'],
    ['win 문자열', { participants: [{ puuid: PUUID, win: 'false' }] }, 'INVALID_MATCH_DATA'],
    ['종료 시각 없음', { extraInfo: { gameEndTimestamp: undefined } }, 'INVALID_MATCH_DATA'],
  ];
  for (const [label, overrides, code] of scenarios) {
    const good = historyFrom([true, true, true, true, true, true]);
    good.details[good.ids[3]] = detail(good.ids[3], overrides);
    const riot = createRiotMock(good);
    const service = loadService(riot.mock);
    await assert.rejects(service.getPrediction(PUUID), (err) => err.code === code, label);
    assert.equal(service.__testing.caches.resultCache.size, 0, label);
  }

  const missing = historyFrom([true, false, true, false, true, false]);
  delete missing.details[missing.ids[2]];
  const service404 = loadService(createRiotMock(missing).mock);
  await assert.rejects(service404.getPrediction(PUUID), (err) => err.code === 'MATCH_NOT_FOUND');

  const broken = historyFrom([true, false, true, false, true, false]);
  const riot500 = createRiotMock({ ...broken, detailErrors: { [broken.ids[4]]: httpError(503) } });
  const service500 = loadService(riot500.mock);
  const err = await service500.getPrediction(PUUID).catch((e) => e);
  assert.equal(service500.classifyPredictionError(err).code, 'UPSTREAM');
  assert.equal(service500.__testing.caches.resultCache.size, 0);
});

test('성공한 빈 목록은 0경기 결과, 4경기 이하는 추정치 없이 요약만 반환한다', async () => {
  const empty = loadService(createRiotMock({ ids: [] }).mock);
  const r0 = await empty.getPrediction(PUUID);
  assert.equal(r0.sampleSize, 0);
  assert.equal(r0.estimate, null);

  const four = loadService(createRiotMock(historyFrom([true, true, false, true])).mock);
  const r4 = await four.getPrediction(PUUID);
  assert.equal(r4.sampleSize, 4);
  assert.equal(r4.wins, 3);
  assert.equal(r4.estimate, null);

  const embed = four.buildPredictionEmbed({ ...r4, gameName: 'A', tagLine: 'KR1' }).toJSON();
  assert.match(embed.description, /5경기 미만이라 승리·패배 추정치를 표시하지 않습니다/);
  assert.doesNotMatch(embed.description, /승리 참고 추정/);
  assert.doesNotMatch(embed.description, /50\.0%/);
});

test('목록 404는 빈 전적이 아니라 오류로 구분한다', async () => {
  const listError = Object.assign(new Error('없음'), { notFound: true });
  const service = loadService(createRiotMock({ listError }).mock);
  await assert.rejects(service.getPrediction(PUUID), (err) => err.code === 'MATCH_LIST_NOT_FOUND');
});

// ============================================
// 6. 캐시·병합·쿨다운
// ============================================
test('결과 캐시 적중·3분 만료, 동시 요청 병합, 실패 후 잠금 정리', async () => {
  const history = historyFrom([true, false, false, true, true, false, true]);
  const riot = createRiotMock({ ...history, delayMs: 5 });
  const service = loadService(riot.mock);
  let clock = NOW;
  service.__testing.setNow(() => clock);

  const [a, b] = await Promise.all([service.getPrediction(PUUID), service.getPrediction(PUUID)]);
  assert.equal(riot.calls.list.length, 1, '동시 요청은 수집 하나를 공유');
  assert.deepEqual(a, b);
  assert.equal(a.cached, false);

  clock += 2 * 60 * 1000;
  const c = await service.getPrediction(PUUID);
  assert.equal(c.cached, true);
  assert.equal(riot.calls.list.length, 1);

  const detailCallsBefore = riot.calls.detail.length;
  clock += 61 * 1000;
  const d = await service.getPrediction(PUUID);
  assert.equal(d.cached, false);
  assert.equal(riot.calls.list.length, 2, '3분 경과 후 재수집');
  assert.equal(riot.calls.detail.length, detailCallsBefore, '완료된 매치 상세는 캐시 재사용');

  // 실패하면 inflight 잠금이 풀리고 다음 요청이 새로 실행된다
  const failing = createRiotMock({ listError: httpError(500) });
  const failService = loadService(failing.mock);
  await assert.rejects(failService.getPrediction(PUUID));
  assert.equal(failService.__testing.caches.inflight.size, 0);
  await assert.rejects(failService.getPrediction(PUUID));
  assert.equal(failing.calls.list.length, 2);
});

test('같은 서버·사용자에게 15초 쿨다운을 적용하고 다른 서버·사용자는 독립이다', () => {
  const service = loadService(createRiotMock().mock);
  let clock = NOW;
  service.__testing.setNow(() => clock);

  assert.equal(service.tryAcquireCooldown('g1', 'u1'), 0);
  assert.equal(service.tryAcquireCooldown('g1', 'u1'), 15000);
  assert.equal(service.tryAcquireCooldown('g2', 'u1'), 0);
  assert.equal(service.tryAcquireCooldown('g1', 'u2'), 0);
  clock += 14999;
  assert.equal(service.tryAcquireCooldown('g1', 'u1'), 1);
  clock += 1;
  assert.equal(service.tryAcquireCooldown('g1', 'u1'), 0);
});

// ============================================
// 7. 오류 분류·기한
// ============================================
test('401/403/404/429/5xx/네트워크/취소 오류를 구분하고 로그에 인증 헤더를 남기지 않는다', () => {
  const service = loadService(createRiotMock().mock);
  const code = (err) => service.classifyPredictionError(err).code;
  assert.equal(code(httpError(401)), 'AUTH');
  assert.equal(code(httpError(403)), 'AUTH');
  assert.doesNotMatch(service.classifyPredictionError(httpError(403)).message, /만료/);
  assert.equal(code(httpError(429)), 'RATE_LIMITED');
  assert.equal(code(httpError(500)), 'UPSTREAM');
  assert.equal(code(httpError(502)), 'UPSTREAM');
  assert.equal(code(Object.assign(new Error('socket hang up'), { isAxiosError: true, code: 'ECONNRESET' })), 'NETWORK');
  assert.equal(code(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })), 'TIMEOUT');
  assert.equal(code(new service.PredictionError('ACCOUNT_NOT_FOUND')), 'ACCOUNT_NOT_FOUND');
  assert.equal(code(new TypeError('x')), 'UNKNOWN');

  const log = service.describeErrorForLog(httpError(403));
  assert.match(log, /AUTH status=403/);
  assert.doesNotMatch(log, /RGAPI/);
});

test('전체 기한을 넘기면 TIMEOUT으로 끝나고 남은 상세 조회는 건너뛴다', async () => {
  const history = historyFrom(Array.from({ length: 20 }, () => true));
  const riot = createRiotMock({ ...history, delayMs: 20 });
  const service = loadService(riot.mock);

  await assert.rejects(
    service.predictForTarget({ puuid: PUUID, gameName: 'A', tagLine: 'KR1' }, { deadlineMs: 70 }),
    (err) => err.code === 'TIMEOUT'
  );
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(riot.calls.detail.length < 20, `상세 조회 ${riot.calls.detail.length}건에서 중단`);
  assert.equal(service.__testing.caches.inflight.size, 0);
});

test('직접 입력은 계정을 조회하고, 계정 404는 ACCOUNT_NOT_FOUND로 안내한다', async () => {
  const riot = createRiotMock({ ...historyFrom([true, true, true, true, true]), account: { puuid: PUUID, gameName: 'Hide on bush', tagLine: 'KR1' } });
  const service = loadService(riot.mock);
  const result = await service.predictForTarget({ gameName: 'hide on bush', tagLine: 'kr1' });
  assert.equal(result.gameName, 'Hide on bush');
  assert.equal(result.tagLine, 'KR1');
  assert.equal(riot.calls.account[0].gameName, 'hide on bush');

  const notFound = loadService(createRiotMock().mock);
  await assert.rejects(notFound.predictForTarget({ gameName: 'x', tagLine: 'y' }), (err) => err.code === 'ACCOUNT_NOT_FOUND');
});

// ============================================
// 5. 옵션 파싱
// ============================================
test('옵션: 본인/멤버/직접 입력, 충돌·반쪽 입력은 사용법 안내, 내부 공백 보존', () => {
  const { parsePredictionOptions } = loadService(createRiotMock().mock);
  const member = { id: 'm1' };
  assert.deepEqual(parsePredictionOptions({}), { mode: 'self' });
  assert.deepEqual(parsePredictionOptions({ member }), { mode: 'member', member });
  assert.deepEqual(parsePredictionOptions({ gameName: '  Hide on bush ', tagLine: ' KR1 ' }), {
    mode: 'direct',
    gameName: 'Hide on bush',
    tagLine: 'KR1',
  });
  assert.ok(parsePredictionOptions({ member, gameName: 'a', tagLine: 'b' }).error);
  assert.ok(parsePredictionOptions({ member, gameName: 'a' }).error);
  assert.ok(parsePredictionOptions({ gameName: 'a' }).error);
  assert.ok(parsePredictionOptions({ tagLine: 'KR1' }).error);
  assert.ok(parsePredictionOptions({ gameName: '   ', tagLine: 'KR1' }).error);
});

// ============================================
// 5·8·9·10. 명령어
// ============================================
function loadCommand({ riot, players = {}, getPlayerImpl } = {}) {
  const service = loadService(riot.mock);
  const forbidden = (name) => async () => {
    throw new Error(`${name} must not be called`);
  };
  const playerCalls = [];
  const command = loadWithMocks(LOL_PATH, {
    '../services/riotService': {
      fetchLiveGameData: forbidden('fetchLiveGameData'),
      fetchRecentMatchData: forbidden('fetchRecentMatchData'),
    },
    '../services/lolAnalyzer': {
      analyzeLiveGame: forbidden('analyzeLiveGame'),
      analyzeRecentMatches: forbidden('analyzeRecentMatches'),
      parseAnalysisToFields: () => {
        throw new Error('parseAnalysisToFields must not be called');
      },
    },
    '../services/lolTrackerService': {
      registerPlayer: forbidden('registerPlayer'),
      unregisterPlayer: forbidden('unregisterPlayer'),
      setTrackerChannel: forbidden('setTrackerChannel'),
      getRegisteredPlayers: forbidden('getRegisteredPlayers'),
      getTrackerChannel: forbidden('getTrackerChannel'),
      ensureTrackerRole: forbidden('ensureTrackerRole'),
      setChannelPermissions: forbidden('setChannelPermissions'),
      addTrackerRole: forbidden('addTrackerRole'),
      removeTrackerRole: forbidden('removeTrackerRole'),
      async getPlayer(guildId, userId) {
        playerCalls.push([guildId, userId]);
        if (getPlayerImpl) return getPlayerImpl(guildId, userId);
        return players[`${guildId}:${userId}`] || null;
      },
    },
    '../services/matchLayoutService': {
      buildRecentMatchLayout: forbidden('buildRecentMatchLayout'),
      buildLiveGameLayout: forbidden('buildLiveGameLayout'),
      buildSingleMatchLayout: forbidden('buildSingleMatchLayout'),
    },
    '../services/lolPredictionService': service,
  });
  return { command, service, playerCalls };
}

function interaction({ guildId = 'g1', userId = 'u1', member = null, gameName = null, tagLine = null, editFails = false } = {}) {
  const log = [];
  const state = { deferred: false, replied: false };
  return {
    log,
    state,
    guild: guildId ? { id: guildId } : null,
    user: { id: userId },
    options: {
      getSubcommand: () => '승부예측',
      getUser: (name) => (name === '멤버' ? member : null),
      getString: (name) => (name === '소환사명' ? gameName : name === '태그' ? tagLine : null),
    },
    async deferReply(opts) {
      assert.ok(!state.deferred && !state.replied, 'defer는 한 번만');
      state.deferred = true;
      log.push(['defer', opts]);
    },
    async reply(value) {
      assert.ok(!state.deferred && !state.replied, '중복 최초 응답 금지');
      state.replied = true;
      log.push(['reply', value]);
    },
    async editReply(value) {
      assert.ok(state.deferred, 'defer 후에만 editReply');
      log.push(['edit', value]);
      if (editFails) throw new Error('Unknown interaction');
    },
  };
}

test.beforeEach(() => {
  process.env.RIOT_API_KEY = 'test-key';
});

test('본인 등록 계정: defer 후 임베드 하나로 응답하고 LLM·라이브 분석을 호출하지 않는다', async () => {
  const riot = createRiotMock(historyFrom([false, false, false, true, false, true, true, false, true, false, false, true, false, true, false, true, false, true, true, false]));
  const { command, playerCalls } = loadCommand({
    riot,
    players: { 'g1:u1': { puuid: PUUID, gameName: '게임이름', tagLine: 'KR1' } },
  });
  const i = interaction();
  await command.execute(i);

  assert.deepEqual(playerCalls, [['g1', 'u1']]);
  assert.equal(i.log[0][0], 'defer');
  assert.equal(i.log.length, 2);
  const [, value] = i.log[1];
  assert.deepEqual(value.allowedMentions, { parse: [] });
  assert.equal(value.embeds.length, 1);
  const embed = value.embeds[0].toJSON();
  assert.equal(embed.title, '🎮 다음 솔랭 승부 예측');
  assert.match(embed.description, /게임이름#KR1/);
  assert.match(embed.description, /최근 20경기: 9승 11패 · 승률 45\.0%/);
  assert.match(embed.description, /최근 5경기: 1승 4패/);
  assert.match(embed.description, /현재 기록: 3연패/);
  assert.match(embed.description, /승리 참고 추정: \*\*47\.5%\*\*/);
  assert.match(embed.description, /패배 참고 추정: \*\*52\.5%\*\*/);
  assert.match(embed.description, /5분 미만 경기 제외/);
  assert.match(embed.footer.text, /history-prior-v1/);
  assert.doesNotMatch(embed.footer.text, /캐시/);
  assert.ok(embed.timestamp);
  assert.ok(embed.description.length < 4096);
  assert.equal(riot.calls.account.length, 0, '저장된 PUUID 재사용');
});

test('멤버 지정은 같은 서버 등록 정보만 사용하고 다른 서버 등록은 미등록으로 본다', async () => {
  const riot = createRiotMock(historyFrom([true, true, true, true, true]));
  const players = { 'g2:m1': { puuid: PUUID, gameName: 'Other', tagLine: 'KR1' } };
  const { command, playerCalls } = loadCommand({ riot, players });

  const i = interaction({ guildId: 'g1', member: { id: 'm1' } });
  await command.execute(i);
  assert.deepEqual(playerCalls, [['g1', 'm1']]);
  const [, value] = i.log[1];
  assert.match(value.content, /<@m1>님은 이 서버에 등록된 롤 계정이 없습니다/);
  assert.match(value.content, /\/전적 등록/);
  assert.deepEqual(value.allowedMentions, { parse: [] });
  assert.equal(riot.calls.list.length, 0, '자동 등록·조회 없음');

  const i2 = interaction({ guildId: 'g2', userId: 'u9', member: { id: 'm1' } });
  await command.execute(i2);
  assert.match(i2.log[1][1].embeds[0].toJSON().description, /Other#KR1/);
});

test('직접 입력은 DB를 보지 않고 Riot ID를 조회하며 마크다운을 이스케이프한다', async () => {
  const riot = createRiotMock({ ...historyFrom([true, true, true, true, true]), account: { puuid: PUUID, gameName: '**굵게**', tagLine: 'KR1' } });
  const { command, playerCalls } = loadCommand({ riot });
  const i = interaction({ gameName: ' **굵게** ', tagLine: ' KR1 ' });
  await command.execute(i);
  assert.deepEqual(playerCalls, []);
  assert.equal(riot.calls.account[0].gameName, '**굵게**');
  assert.match(i.log[1][1].embeds[0].toJSON().description, /\\\*\\\*굵게\\\*\\\*#KR1/);
});

test('옵션 충돌·반쪽 입력·키 미설정·DM은 defer 없이 ephemeral 안내로 끝난다', async () => {
  const riot = createRiotMock();
  const { command } = loadCommand({ riot });

  for (const opts of [
    { member: { id: 'm1' }, gameName: 'a', tagLine: 'b' },
    { gameName: 'a' },
    { tagLine: 'KR1' },
  ]) {
    const i = interaction(opts);
    await command.execute(i);
    assert.equal(i.log.length, 1);
    assert.equal(i.log[0][0], 'reply');
    assert.equal(i.log[0][1].ephemeral, true);
    assert.match(i.log[0][1].content, /사용법/);
  }

  delete process.env.RIOT_API_KEY;
  const noKey = interaction();
  await command.execute(noKey);
  assert.match(noKey.log[0][1].content, /Riot API 키가 설정되지 않아/);

  process.env.RIOT_API_KEY = 'test-key';
  const dm = interaction({ guildId: null });
  await command.execute(dm);
  assert.match(dm.log[0][1].content, /서버 안에서만/);
  assert.equal(riot.calls.list.length + riot.calls.account.length, 0);
});

test('쿨다운 중 재요청은 즉시 안내하고, 두 번째 사용자는 캐시 결과를 받는다', async () => {
  const riot = createRiotMock(historyFrom([true, false, true, false, true]));
  const players = {
    'g1:u1': { puuid: PUUID, gameName: 'A', tagLine: 'KR1' },
    'g1:u2': { puuid: PUUID, gameName: 'A', tagLine: 'KR1' },
  };
  const { command } = loadCommand({ riot, players });

  await command.execute(interaction());
  const again = interaction();
  await command.execute(again);
  assert.equal(again.log[0][0], 'reply');
  assert.match(again.log[0][1].content, /초 후에 다시 시도/);

  const other = interaction({ userId: 'u2' });
  await command.execute(other);
  assert.match(other.log[1][1].embeds[0].toJSON().footer.text, /캐시된 결과/);
  assert.equal(riot.calls.list.length, 1);
});

test('오류 시 로딩 상태를 끝내는 editReply 한 번, editReply 실패도 예외로 번지지 않는다', async () => {
  const riot = createRiotMock({ listError: httpError(403) });
  const { command } = loadCommand({ riot, players: { 'g1:u1': { puuid: PUUID, gameName: 'A', tagLine: 'KR1' } } });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const i = interaction();
    await command.execute(i);
    assert.deepEqual(i.log.map(([kind]) => kind), ['defer', 'edit']);
    assert.match(i.log[1][1].content, /관리자에게 API 키·제품 설정 확인/);
    assert.deepEqual(i.log[1][1].embeds, []);

    const dbFail = loadCommand({ riot, getPlayerImpl: async () => { throw new Error('db down'); } });
    const i2 = interaction({ userId: 'u3', editFails: true });
    await dbFail.command.execute(i2);
    assert.deepEqual(i2.log.map(([kind]) => kind), ['defer', 'edit']);
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.every((line) => !line.includes('RGAPI')), '인증 값이 로그에 남지 않음');
});

test('기존 /전적 하위 명령이 유지되고 승부예측이 추가된다', () => {
  const { command } = loadCommand({ riot: createRiotMock() });
  const json = command.data.toJSON();
  assert.equal(json.name, '전적');
  assert.deepEqual(
    json.options.map((o) => o.name),
    ['등록', '해제', '목록', '채널설정', '실시간', '최근전적', '승부예측']
  );
  const predict = json.options.find((o) => o.name === '승부예측');
  assert.deepEqual(predict.options.map((o) => [o.name, Boolean(o.required)]), [
    ['멤버', false],
    ['소환사명', false],
    ['태그', false],
  ]);
});

// ============================================
// 7·10. riotService 요청 큐
// ============================================
function loadRiot(handler) {
  const urls = [];
  const axios = {
    async get(url, config) {
      urls.push({ url, config });
      return handler(url, urls.length, config);
    },
  };
  const riot = loadWithMocks(RIOT_PATH, { axios });
  return { riot, urls };
}

function quietly(fn) {
  return async () => {
    const original = console.error;
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.error = original;
    }
  };
}

test('getRecentMatchIds 기본 호출은 기존 URL 그대로이고, 옵션을 주면 큐·기간 필터를 붙인다', async () => {
  const { riot, urls } = loadRiot(async () => ({ data: ['KR_1'], headers: {} }));
  assert.deepEqual(await riot.getRecentMatchIds('p u', 5), ['KR_1']);
  assert.equal(
    urls[0].url,
    'https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/p%20u/ids?start=0&count=5'
  );
  await riot.getRecentMatchIds('p', 40, { queue: 420, startTime: 1700000000 });
  assert.equal(
    urls[1].url,
    'https://asia.api.riotgames.com/lol/match/v5/matches/by-puuid/p/ids?start=0&count=40&queue=420&startTime=1700000000'
  );
  await riot.getAccountByRiotId('Hide on bush', 'KR/1');
  assert.equal(
    urls[2].url,
    'https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Hide%20on%20bush/KR%2F1'
  );
});

test('404는 기존처럼 null/[]로, 목록 404는 옵션을 줄 때만 오류로 반환한다', async () => {
  const { riot } = loadRiot(async () => {
    throw httpError(404);
  });
  assert.equal(await riot.getMatchDetail('KR_1'), null);
  assert.deepEqual(await riot.getRecentMatchIds('p', 5), []);
  await assert.rejects(riot.getRecentMatchIds('p', 5, { throwOnNotFound: true }), (err) => err.notFound === true);
  await assert.rejects(riot.getAccountByRiotId('a', 'b'), (err) => err.notFound === true && Boolean(err.userMessage));
});

test('401/403은 재시도하지 않는다', quietly(async () => {
  for (const status of [401, 403]) {
    const { riot, urls } = loadRiot(async () => {
      throw httpError(status);
    });
    await assert.rejects(riot.getMatchDetail('KR_1'), (err) => err.response.status === status);
    assert.equal(urls.length, 1);
  }
}));

test('429 재시도를 모두 쓰면 reject되고 큐의 다음 요청은 정상 처리된다', quietly(async () => {
  const { riot, urls } = loadRiot(async (url) => {
    if (url.includes('KR_RATE')) throw httpError(429, { 'retry-after': '0' });
    return { data: { ok: true }, headers: {} };
  });
  const limited = riot.getMatchDetail('KR_RATE');
  const next = riot.getMatchDetail('KR_OK');
  await assert.rejects(limited, (err) => err.response.status === 429);
  assert.deepEqual(await next, { ok: true });
  assert.equal(urls.filter(({ url }) => url.includes('KR_RATE')).length, 3);
}));

test('5xx·네트워크 오류는 재시도 후 reject되고 큐는 계속 동작한다', quietly(async () => {
  let fail = true;
  const { riot, urls } = loadRiot(async () => {
    if (fail) throw httpError(503);
    return { data: 'ok', headers: {} };
  });
  await assert.rejects(riot.getMatchDetail('KR_1'), (err) => err.response.status === 503);
  assert.equal(urls.length, 3);
  fail = false;
  assert.equal(await riot.getMatchDetail('KR_2'), 'ok');
}));

test('취소된 요청은 즉시 reject되고 큐 차례가 와도 호출하지 않는다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { riot, urls } = loadRiot(async (url) => {
    if (url.includes('KR_SLOW')) await gate;
    return { data: url, headers: {} };
  });
  const slow = riot.getMatchDetail('KR_SLOW');
  const controller = new AbortController();
  const skipped = riot.getMatchDetail('KR_SKIP', { signal: controller.signal });
  const after = riot.getMatchDetail('KR_AFTER');
  controller.abort();
  await assert.rejects(skipped, (err) => err.name === 'AbortError');
  release();
  await slow;
  await after;
  assert.deepEqual(urls.map(({ url }) => url.split('/').pop()), ['KR_SLOW', 'KR_AFTER']);
});

test('응답 헤더상 한도에 도달한 창이 있으면 그 창 길이만큼 대기한다', () => {
  const { riot } = loadRiot(async () => ({ data: null, headers: {} }));
  assert.equal(riot.getRateLimitWaitMs({}), 0);
  assert.equal(
    riot.getRateLimitWaitMs({ 'x-app-rate-limit': '20:1,100:120', 'x-app-rate-limit-count': '3:1,57:120' }),
    0
  );
  assert.equal(
    riot.getRateLimitWaitMs({ 'x-app-rate-limit': '20:1,100:120', 'x-app-rate-limit-count': '3:1,100:120' }),
    120000
  );
  assert.equal(
    riot.getRateLimitWaitMs({ 'x-method-rate-limit': '2000:10', 'x-method-rate-limit-count': '2000:10' }),
    10000
  );
});
