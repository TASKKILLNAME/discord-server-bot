// ============================================
// 📊 Stat Normalizer — 티어 보정 핵심 모듈
// 절대 수치 → 티어 평균 대비 상대 점수 변환
// 반환: -2(매우낮음) ~ +2(매우높음)
// ============================================

const { TIER_EXPECTATIONS, ROLE_CS_MODIFIER } = require('../constants/tierExpectations');
const { CHAMPION_FLAGS } = require('../constants/championFlags');

function normalizeStats(rawStats, tier, champion, role) {
  const tierAvg = TIER_EXPECTATIONS[tier.toLowerCase()] || TIER_EXPECTATIONS.gold;
  const flags = CHAMPION_FLAGS[champion] || { cs_offset: 0, kda_offset: 0 };
  const roleModifier = (role && ROLE_CS_MODIFIER[role]) || 0;

  // 보정된 티어 평균 계산 (챔피언 보정 + 역할 보정)
  const adjustedAvg = {
    cs_per_min: Math.max(1, tierAvg.cs_per_min + (flags.cs_offset || 0) + roleModifier),
    kda: tierAvg.kda + (flags.kda_offset || 0),
    vision_score: tierAvg.vision_score,
  };

  return {
    cs_score: calcRelative(rawStats.cs_per_min, adjustedAvg.cs_per_min),
    kda_score: calcRelative(rawStats.kda, adjustedAvg.kda),
    vision_score: calcRelative(rawStats.vision_score, adjustedAvg.vision_score),
    context_flags: {
      is_roam: flags.is_roam || false,
      is_dive: flags.is_dive || false,
    },
    adjusted_avg: adjustedAvg,
  };
}

// 상대 점수 계산 함수
// diff가 ±15% 이내 = 0(평균), ±30% = ±1, ±50% 이상 = ±2
function calcRelative(actual, avg) {
  if (avg <= 0) return 0;
  const diff = (actual - avg) / avg;
  if (diff >= 0.5) return 2;
  if (diff >= 0.15) return 1;
  if (diff <= -0.5) return -2;
  if (diff <= -0.15) return -1;
  return 0;
}

// 챔피언 풀 전체 분석 (모스트 3개 종합)
function analyzeChampionPool(championBreakdown, tier) {
  return championBreakdown.map((champ) => {
    const normalized = normalizeStats(
      { cs_per_min: champ.avg_cs, kda: champ.avg_kda, vision_score: 0 },
      tier,
      champ.name,
      champ.role,
    );
    return {
      ...champ,
      cs_vs_avg: normalized.cs_score,
      kda_vs_avg: normalized.kda_score,
      flags: normalized.context_flags,
    };
  });
}

// 프롬프트에 넣기 전 sanitize
// 고elo면 기초 지표 relative 0 이상은 아예 제거 (언급 가치 없음)
function sanitizeForPrompt(normalizedData, tier) {
  const highElo = ['master', 'grandmaster', 'challenger'];
  const isHighElo = highElo.includes(tier.toLowerCase());

  const sanitized = JSON.parse(JSON.stringify(normalizedData));

  if (isHighElo && sanitized.relative) {
    Object.keys(sanitized.relative).forEach((key) => {
      if (sanitized.relative[key] >= 0) {
        sanitized.relative[key] = 'ABOVE_AVG_SKIP';
      }
    });
  }

  return sanitized;
}

module.exports = { normalizeStats, analyzeChampionPool, sanitizeForPrompt, calcRelative };
