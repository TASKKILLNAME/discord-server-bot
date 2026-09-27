// ============================================
// 🕵️ 메튜렁의 첩자 — 순수 계산 로직 (API·Discord·DB 무관)
//
// "첩자"는 과거 경기에서 부진했던 아군을 재미로 부르는 이름일 뿐,
// 매치메이킹이 의도적으로 배치했다는 뜻이 아니다.
// ============================================

const SPY_CONFIG = Object.freeze({
  modelVersion: 'spy-ingame-v1',
  // 이 점수 이상이면 해당 경기의 "첩자 의심" 아군으로 센다.
  // 압축 후 범위가 10~90이므로 65는 원점수 약 69 이상, 즉 대부분 항목에서 부진한 경우다.
  scoreThreshold: 65,
  minSampleSize: 10,
  maxBucket: 3, // 0 / 1 / 2 / 3명+ (기대값 계산 시 3명+는 3명으로 본다)

  // 한 경기 안의 성적만 쓴다. 승패는 넣지 않는다(패배했다고 전원 첩자가 되지 않도록).
  // KDA·데스는 개인 부진을, 킬관여는 팀 기여를, 라인 골드는 포지션 차이를 보정한 비교를 반영한다.
  weights: { kda: 0.3, killParticipation: 0.25, deaths: 0.25, laneGold: 0.2 },

  // 각 항목을 0(양호)~100(부진) 위험 점수로 바꾸는 기준
  kdaGood: 4, // KDA 4 이상 → 0, 0 → 100
  killParticipationGood: 0.6, // 킬관여 60% 이상 → 0
  // 팀 킬이 너무 적으면(팀 전체가 밀린 경기) 부진한 아군도 킬관여율이 높게 나오므로 이 항목을 뺀다
  killParticipationMinTeamKills: 10,
  deathsPer10Low: 1.5, // 10분당 데스 1.5 이하 → 0
  deathsPer10High: 4.5, // 4.5 이상 → 100
  laneGoldRatioGood: 1.15, // 같은 포지션 상대 대비 골드 115% 이상 → 0
  laneGoldRatioBad: 0.85, // 85% 이하 → 100

  // 극단값 완화: 최종 점수 = floor + 원점수 × scale (10~90)
  scoreFloor: 10,
  scoreScale: 0.8,
});

function clamp01to100(value) {
  return Math.min(100, Math.max(0, value));
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 한 경기에서 한 아군의 첩자 점수(10~90). 필수 값(K/D/A)이 없으면 null.
 * stats: { kills, deaths, assists, teamKills, durationSec, gold, laneOpponentGold }
 */
function calculateSpyScore(stats) {
  const { kills, deaths, assists, teamKills, durationSec, gold, laneOpponentGold } = stats || {};
  if (![kills, deaths, assists].every(isNonNegativeNumber)) return null;

  const c = SPY_CONFIG;
  const components = {};

  const kda = (kills + assists) / Math.max(1, deaths);
  components.kda = clamp01to100(100 * (1 - kda / c.kdaGood));

  if (isNonNegativeNumber(teamKills) && teamKills >= c.killParticipationMinTeamKills) {
    const kp = Math.min(1, (kills + assists) / teamKills);
    components.killParticipation = clamp01to100(100 * (1 - kp / c.killParticipationGood));
  }

  if (isNonNegativeNumber(durationSec) && durationSec > 0) {
    const per10 = deaths / (durationSec / 600);
    components.deaths = clamp01to100((100 * (per10 - c.deathsPer10Low)) / (c.deathsPer10High - c.deathsPer10Low));
  }

  if (isNonNegativeNumber(gold) && isNonNegativeNumber(laneOpponentGold) && laneOpponentGold > 0) {
    const ratio = gold / laneOpponentGold;
    components.laneGold = clamp01to100((100 * (c.laneGoldRatioGood - ratio)) / (c.laneGoldRatioGood - c.laneGoldRatioBad));
  }

  // 없는 항목은 빼고 남은 가중치로 다시 나눈다
  let weighted = 0;
  let weightSum = 0;
  for (const [key, value] of Object.entries(components)) {
    weighted += value * c.weights[key];
    weightSum += c.weights[key];
  }
  const raw = weighted / weightSum;
  return c.scoreFloor + raw * c.scoreScale;
}

/**
 * 한 경기에서 대상 플레이어의 아군 4명 중 첩자 의심 인원. 판단할 수 없으면 null.
 * match.players: [{ puuid, teamId, kills, deaths, assists, goldEarned, teamPosition }]
 */
function countSpiesInMatch(match, puuid) {
  const players = Array.isArray(match?.players) ? match.players : [];
  const me = players.find((p) => p.puuid === puuid);
  if (!me) return null;

  const allies = players.filter((p) => p.teamId === me.teamId && p.puuid !== puuid);
  if (allies.length !== 4) return null;

  const teamKills = players
    .filter((p) => p.teamId === me.teamId)
    .reduce((sum, p) => sum + (isNonNegativeNumber(p.kills) ? p.kills : 0), 0);

  let spies = 0;
  for (const ally of allies) {
    const opponent = ally.teamPosition
      ? players.find((p) => p.teamId !== me.teamId && p.teamPosition === ally.teamPosition)
      : null;
    const score = calculateSpyScore({
      kills: ally.kills,
      deaths: ally.deaths,
      assists: ally.assists,
      teamKills,
      durationSec: match.gameDuration,
      gold: ally.goldEarned,
      laneOpponentGold: opponent?.goldEarned,
    });
    if (score === null) return null; // 한 명이라도 판단 불가면 이 경기는 표본에서 뺀다
    if (score >= SPY_CONFIG.scoreThreshold) spies++;
  }
  return spies;
}

/**
 * 최신순 승패 배열에서 index 경기 "시작 직전"의 연승/연패.
 * 이전 경기가 없으면 null, 표본 끝까지 같은 결과면 truncated(실제로는 그 이상일 수 있음).
 */
function streakBefore(results, index) {
  if (index + 1 >= results.length) return null;
  const first = results[index + 1];
  let count = 0;
  while (index + 1 + count < results.length && results[index + 1 + count] === first) count++;
  return { win: first, count, truncated: index + 1 + count >= results.length };
}

/** samples(첩자 수 배열) → 0/1/2/3명+ 비율. 빈 배열이면 null. */
function calculateSpyDistribution(samples) {
  if (!samples.length) return null;
  const counts = new Array(SPY_CONFIG.maxBucket + 1).fill(0);
  for (const spies of samples) counts[Math.min(spies, SPY_CONFIG.maxBucket)]++;
  return counts.map((count) => count / samples.length);
}

function calculateExpectedSpyCount(distribution) {
  return distribution.reduce((sum, p, spies) => sum + p * spies, 0);
}

/** 비율을 합계가 정확히 100인 정수 %로 (최대 잔여 방식) */
function toWholePercents(distribution) {
  const raw = distribution.map((p) => p * 100);
  const floors = raw.map(Math.floor);
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, i) => ({ i, rest: value - floors[i] }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floors[i]++;
    remaining--;
  }
  return floors;
}

/**
 * 현재 연승/연패와 비슷한 상태에서 시작한 과거 경기의 첩자 수 분포.
 * games: 최신순 [{ win, match }]. 표본이 minSampleSize 미만이면 조건을 단계적으로 완화하고,
 * 끝까지 부족하면 { insufficient: true }.
 */
function calculateSpyPrediction(games, puuid) {
  const results = games.map((g) => g.win);
  const current = streakBefore(results, -1); // index -1 = 다음 판 시작 직전(현재 상태)

  const candidates = games
    .map((game, index) => ({
      spies: countSpiesInMatch(game.match, puuid),
      before: streakBefore(results, index),
    }))
    .filter((c) => c.spies !== null);

  const insufficient = { insufficient: true, eligibleGames: candidates.length };
  if (!current) return insufficient;

  const low = Math.max(1, current.count - 1);
  const high = current.count + 1;
  const label = current.win ? '연승' : '연패';
  const stages = [
    {
      condition: `${low}~${high}${label} 상태에서 시작한 경기`,
      filter: (c) => c.before && !c.before.truncated && c.before.win === current.win
        && c.before.count >= low && c.before.count <= high,
    },
    {
      condition: `${label} 중에 시작한 경기`,
      filter: (c) => c.before && c.before.win === current.win,
    },
    { condition: '최근 경기 전체', filter: () => true },
  ];

  for (const [index, stage] of stages.entries()) {
    const samples = candidates.filter(stage.filter).map((c) => c.spies);
    if (samples.length < SPY_CONFIG.minSampleSize) continue;
    const distribution = calculateSpyDistribution(samples);
    const percents = toWholePercents(distribution);
    return {
      insufficient: false,
      stage: index + 1,
      condition: stage.condition,
      sampleSize: samples.length,
      distribution,
      existProbability: 1 - distribution[0],
      expectedCount: calculateExpectedSpyCount(distribution),
      percents,
      existPercent: 100 - percents[0],
    };
  }
  return insufficient;
}

module.exports = {
  SPY_CONFIG,
  calculateSpyScore,
  countSpiesInMatch,
  streakBefore,
  calculateSpyDistribution,
  calculateExpectedSpyCount,
  toWholePercents,
  calculateSpyPrediction,
};
