'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRecentGames, extractRecentGame, normalizeRole } = require('../src/services/playerAnalysisService');
const { assignTeamRoles, detectOffRole } = require('../src/services/roleAnalyzer');
const { calculateSpyScore } = require('../src/services/spyAnalyzer');

function games(count = 20, override = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    matchId: `KR_${i}`, endedAt: 20000 - i, win: true,
    championId: 103, championName: '아리', teamPosition: 'MIDDLE', ...override(i),
  }));
}
function player(recent, role = 'MID', championId = 103) {
  return { championId, currentRole: { role, confidence: 0.9 },
    analysis: analyzeRecentGames(recent, championId) };
}

test('주 포지션과 현재 포지션이 같으면 정상이며 티어는 점수에 영향을 주지 않는다', () => {
  const p = player(games());
  const result = calculateSpyScore(p);
  assert.equal(result.offRole.status, 'NORMAL');
  assert.equal(result.score, 0);
  assert.deepEqual(calculateSpyScore({ ...p, rank: 'IRON IV' }), calculateSpyScore({ ...p, rank: 'CHALLENGER' }));
});

test('명백한 라인 꼬임·현챔 0판·5연패의 점수와 근거가 결정적이다', () => {
  const p = player(games(20, (i) => ({ teamPosition: i < 16 ? 'UTILITY' : 'TOP',
    championId: 902, championName: '밀리오', win: i >= 5 && i < 13 })), 'JUNGLE', 64);
  const first = calculateSpyScore(p);
  assert.equal(first.offRole.status, 'SUSPECTED');
  assert.equal(first.score, 95); // 35 + 20 + 15 + 10 + 15
  assert.equal(first.level, 'HIGH');
  assert.equal(first.confidence, 0.9);
  assert.deepEqual(first.reasons, ['OFF_ROLE', 'LOW_CURRENT_CHAMP_EXPERIENCE', 'LOSS_STREAK', 'LOW_RECENT_WINRATE', 'LOW_CURRENT_ROLE_EXPERIENCE']);
  const before = JSON.stringify(p);
  for (let i = 0; i < 10; i++) assert.deepEqual(calculateSpyScore(p), first);
  assert.equal(JSON.stringify(p), before);
});

test('라인 꼬임 기준 10개 유효 포지션·주 포지션 50%·현재 25% 경계', () => {
  const stats = analyzeRecentGames(games(20, (i) => ({ teamPosition: i < 10 ? 'UTILITY' : i < 15 ? 'JUNGLE' : 'TOP' })), 103);
  assert.equal(detectOffRole(stats, { role: 'JUNGLE', confidence: 0.75 }).status, 'SUSPECTED');
  assert.equal(detectOffRole(stats, { role: 'JUNGLE', confidence: 0.74 }).status, 'DEFERRED');
  const nine = player(games(9), 'TOP');
  assert.equal(detectOffRole(nine.analysis, nine.currentRole).status, 'DEFERRED');
});

test('최근 3판에 현챔이 없어도 경험 부족 20점으로 평가하지 않는다', () => {
  const p = player(games(3), 'MID', 64);
  const result = calculateSpyScore(p);
  assert.equal(result.score, null);
  assert.deepEqual(result.components, {});
  assert.deepEqual(result.reasons, []);
  assert.equal(result.unavailableReason, 'INSUFFICIENT_SAMPLE');
});

test('충분한 표본에서만 현재 챔피언 0판에 20점을 부여한다', () => {
  const result = calculateSpyScore(player(games(), 'MID', 64));
  assert.equal(result.score, 20);
  assert.equal(result.components.championExperience, 20);
});

test('Unknown·빈 포지션은 유효 포지션 분모에서 제외하고 9개면 분석 보류한다', () => {
  const p = player(games(20, (i) => ({ teamPosition: i < 9 ? 'MIDDLE' : i < 15 ? 'UNKNOWN' : '' })));
  assert.equal(p.analysis.roleSample, 9);
  assert.equal(p.analysis.primaryRoleRate, 1);
  assert.equal(calculateSpyScore(p).score, null);
  assert.equal(normalizeRole('UNKNOWN'), null);
  assert.equal(normalizeRole('toString'), null);
  assert.equal(normalizeRole(''), null);
  assert.equal(normalizeRole('BOTTOM'), 'ADC');
  assert.equal(normalizeRole('UTILITY'), 'SUPPORT');
});

test('최근 주챔은 플레이 횟수 상위 2개이며 실제 표본과 챔피언별 승률을 사용한다', () => {
  const stats = analyzeRecentGames(games(9, (i) => ({ championId: i < 5 ? 103 : i < 8 ? 55 : 238,
    championName: i < 5 ? '아리' : i < 8 ? '카타리나' : '제드', win: i < 3 || i === 5 })), 55);
  assert.equal(stats.sampleSize, 9);
  assert.equal(stats.wins, 4);
  assert.equal(stats.losses, 5);
  assert.equal(stats.currentChampionGames, 3);
  assert.deepEqual(stats.mainChampions.map((c) => [c.name, c.games, c.wins, c.losses]),
    [['아리', 5, 3, 2], ['카타리나', 3, 1, 2]]);
  assert.equal(stats.mainChampions[0].winRate, 0.6);
});

test('연패는 종료 시각 최신순으로 계산하고 승리에서 멈춘다', () => {
  const stats = analyzeRecentGames(games(20, (i) => ({ win: i >= 5 })).reverse(), 103);
  assert.equal(stats.lossStreak, 5);
  assert.equal(calculateSpyScore({ analysis: stats, currentRole: { role: 'MID', confidence: 0.9 }, championId: 103 }).components.lossStreak, 10);
  assert.equal(analyzeRecentGames(games(3, () => ({ win: false })), 103).streakAtLeast, true);
});

test('API 실패·비공개·손상된 데이터는 0점이나 위험 점수 대신 null이다', () => {
  assert.equal(calculateSpyScore({ analysis: { status: 'error' } }).score, null);
  assert.equal(calculateSpyScore({ private: true }).unavailableReason, 'PRIVATE');
  const p = player(games());
  p.analysis.winRate = NaN;
  assert.equal(calculateSpyScore(p).score, null);
});

test('포지션 공동 1위는 임의의 주 포지션이나 라인 꼬임으로 만들지 않는다', () => {
  const p = player(games(20, (i) => ({ teamPosition: i < 10 ? 'TOP' : 'MIDDLE' })));
  assert.equal(p.analysis.primaryRole, null);
  assert.equal(calculateSpyScore(p).score, null);
});

test('팀 단위 배정은 라인을 중복하지 않으며 Smite를 정글의 강한 근거로 사용한다', () => {
  const lineup = [
    { championName: 'Top', spell1Id: 4 },
    { championName: 'SupportMain', spell1Id: 11, analysis: analyzeRecentGames(games(20, () => ({ teamPosition: 'UTILITY' })), 103) },
    { championName: 'Mid', spell1Id: 4 },
    { championName: 'Adc', spell1Id: 4 },
    { championName: 'Support', spell1Id: 4 },
  ];
  const roles = { Top: ['TOP'], SupportMain: ['JUNGLE'], Mid: ['MID'], Adc: ['ADC'], Support: ['SUPPORT'] };
  const assigned = assignTeamRoles(lineup, (name) => roles[name]);
  assert.deepEqual(assigned.map((p) => p.currentRole.role), ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']);
  assert.ok(assigned[1].currentRole.confidence >= 0.75);
  assert.equal(detectOffRole(assigned[1].analysis, assigned[1].currentRole).status, 'SUSPECTED');
});

test('근거가 같은 5명은 고유 라인으로 배정하되 confidence가 낮다', () => {
  const assigned = assignTeamRoles(Array.from({ length: 5 }, () => ({ championName: '?' })), () => []);
  assert.equal(new Set(assigned.map((p) => p.currentRole.role)).size, 5);
  assert.ok(assigned.every((p) => p.currentRole.confidence < 0.75));
});

test('솔랭 이외 경기·5분 미만 경기는 제외하고 잘못된 계정 매치는 거부한다', () => {
  const detail = { metadata: { matchId: 'KR_1' }, info: { queueId: 420, gameDuration: 1500,
    gameEndTimestamp: 123, participants: [{ puuid: 'p', championId: 103, win: true, teamPosition: '' }] } };
  assert.equal(extractRecentGame(detail, 'p', 'KR_1', () => '아리').teamPosition, '');
  assert.throws(() => extractRecentGame(detail, 'other', 'KR_1', () => '아리'));
  assert.throws(() => extractRecentGame(detail, 'p', 'KR_2', () => '아리'));
  assert.equal(extractRecentGame({ ...detail, info: { ...detail.info, queueId: 450 } }, 'p', 'KR_1', () => '아리'), null);
  assert.equal(extractRecentGame({ ...detail, info: { ...detail.info, gameDuration: 299 } }, 'p', 'KR_1', () => '아리'), null);
});

test('승률·연패·현챔 경험 경계에서 점수는 0~100의 정수이고 입력을 바꾸지 않는다', () => {
  for (let wins = 0; wins <= 20; wins++) {
    for (let champGames = 0; champGames <= 6; champGames++) {
      const p = player(games(20, (i) => ({ win: i >= 20 - wins, championId: i < champGames ? 103 : 55 })));
      const result = calculateSpyScore(p);
      assert.ok(Number.isInteger(result.score) && result.score >= 0 && result.score <= 100);
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    }
  }
  const withWins = (wins) => calculateSpyScore(player(games(20, (i) => ({ win: i < wins })))).components.recentWinRate;
  assert.deepEqual([11, 10, 9, 8, 6].map(withWins), [0, 5, 10, 15, 20]);
});
