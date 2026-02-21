// ============================================
// 🧠 Coach Analyzer — Claude AI 전문 코칭 서비스
// "10년 경력의 냉철한 전문 코치" 페르소나
// ============================================

const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ ANTHROPIC_API_KEY가 설정되지 않았습니다.');
      return null;
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const COACH_SYSTEM_PROMPT = `당신은 10년 경력의 리그 오브 레전드 프로 코치입니다.
냉철하고 직설적이며, 빈말이나 위로 없이 데이터에 기반한 팩트만 말합니다.
플레이어의 감정이 아닌 실력 향상에만 집중합니다.
모든 피드백은 구체적인 수치와 타임스탬프를 근거로 제시합니다.
"잘했다"는 말 대신 "이건 됐고, 이건 고쳐라"식으로 말합니다.
한국어로 답변하며, 존댓말 대신 반말체("~해라", "~이다")를 사용합니다.
수치를 나열하는 것이 아니라, "이 상황에서는 이렇게 했어야 한다"는 행동 지침을 출력합니다.`;

// ============================================
// 🔍 /분석 명령어용 — 의사결정 분석
// ============================================
async function analyzeDecisions(decisionData) {
  const anthropic = getClient();
  if (!anthropic) return getFallbackDecisionAnalysis(decisionData);

  const deathSummary = decisionData.deathAnalysis
    .map((d, i) => {
      const goldStr = d.goldDiffBeforeDeath > 0
        ? `+${d.goldDiffBeforeDeath}`
        : `${d.goldDiffBeforeDeath}`;
      return `  ${i + 1}. ${d.minuteMark.toFixed(1)}분 - ${translateLocationType(d.locationType)} | 1분전 골드차: ${goldStr} | ${translateDeathContext(d.deathContext)}`;
    })
    .join('\n');

  const missedObjStr = decisionData.objectiveParticipation.missedObjectives
    .map((o) => `${translateMonsterType(o.type)}(${o.minuteMark.toFixed(1)}분)`)
    .join(', ');

  const prompt = `다음 플레이어의 의사결정 데이터를 분석해라.

## 플레이어 정보
챔피언: ${decisionData.playerInfo.champion} (${translateRole(decisionData.playerInfo.role)})
결과: ${decisionData.playerInfo.win ? '승리' : '패배'}
KDA: ${decisionData.playerInfo.kills}/${decisionData.playerInfo.deaths}/${decisionData.playerInfo.assists}
랭크: ${decisionData.playerInfo.rank || '정보 없음'}
게임 시간: ${Math.floor(decisionData.gameDuration / 60)}분

## 사망 분석 (${decisionData.deathAnalysis.length}번 사망)
${deathSummary || '사망 없음'}

## 오브젝트 참여
참여율: ${decisionData.objectiveParticipation.participationRate}% (${decisionData.objectiveParticipation.participated}/${decisionData.objectiveParticipation.totalObjectives})
불참 오브젝트: ${missedObjStr || '없음'}

## 골드 효율
10분 골드차: ${decisionData.goldEfficiency.goldDiffAt10 > 0 ? '+' : ''}${decisionData.goldEfficiency.goldDiffAt10}
15분 골드차: ${decisionData.goldEfficiency.goldDiffAt15 > 0 ? '+' : ''}${decisionData.goldEfficiency.goldDiffAt15}
10분 CS: ${decisionData.goldEfficiency.csAt10}
15분 CS: ${decisionData.goldEfficiency.csAt15}
리콜 횟수: ${decisionData.goldEfficiency.backTimings.length}

## 시야
총 와드: ${decisionData.visionTimeline.wardsPlacedTotal} | 초반(~15분): ${decisionData.visionTimeline.earlyWardsPlaced} | 후반: ${decisionData.visionTimeline.lateWardsPlaced}
와드 제거: ${decisionData.visionTimeline.wardsKilledTotal}

## 전투
킬관여율: ${decisionData.combatProfile.killParticipation}% | 솔로킬: ${decisionData.combatProfile.soloKills}
딜량: ${decisionData.combatProfile.damageDealt.toLocaleString()} | 받은 피해: ${decisionData.combatProfile.damageTaken.toLocaleString()}

분석 형식:
## 🔍 핵심 문제점 (최대 3개)
(데이터 근거 + 왜 문제인지 + "이 상황에서는 이렇게 했어야 한다")

## ⚰️ 죽음 패턴 분석
(반복되는 패턴 짚어서 각 1문장)

## 🎯 오브젝트 참여 평가
(참여율 기반 + 불참 오브젝트 시점 분석)

## 💡 다음 게임 실천 사항 (3개)
(구체적 행동 지침: "~분에 ~해라" 식으로)`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: COACH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].text;
  } catch (err) {
    console.error('AI 코칭 분석 실패:', err.message);
    return getFallbackDecisionAnalysis(decisionData);
  }
}

// ============================================
// 📊 /메타 명령어용 — 메타 영향 분석
// ============================================
async function analyzeMetaImpact(playstyleProfile, patchData) {
  const anthropic = getClient();
  if (!anthropic) return getFallbackMetaAnalysis(playstyleProfile);

  // 유저 챔피언 풀과 관련된 패치 변경사항 필터링
  const relevantChanges = (patchData.champions || []).filter((c) =>
    playstyleProfile.championPool.some((cp) => cp.champion === c.name)
  );

  const prompt = `다음 플레이어의 플레이스타일과 현재 패치를 기반으로 메타 코칭을 해라.

## 플레이어 프로필
닉네임: ${playstyleProfile.summonerName}
랭크: ${playstyleProfile.rank}
최근 ${playstyleProfile.totalGames}게임 승률: ${playstyleProfile.winRate}%

## 플레이스타일 수치 (1~10)
공격성: ${playstyleProfile.aggression}/10 (평균 솔로킬 ${playstyleProfile.avgSoloKills}, 평균 데스 ${playstyleProfile.avgDeaths})
로밍: ${playstyleProfile.roaming}/10
시야: ${playstyleProfile.visionScore}/10 (평균 ${playstyleProfile.avgVisionScore})
CS: ${playstyleProfile.csSkill}/10 (평균 ${playstyleProfile.avgCsPerMin}/분)
후반 운영: ${playstyleProfile.lateGameSkill}/10

## 주력 챔피언 (TOP 3)
${playstyleProfile.championPool.map((c, i) => `${i + 1}. ${c.champion} - ${c.games}판 ${c.winRate}% | KDA ${c.avgKDA} | ${translateRole(c.role)}`).join('\n')}

## 포지션 분포
${Object.entries(playstyleProfile.roleDistribution).filter(([, v]) => v > 0).map(([k, v]) => `${translateRole(k)}: ${v}%`).join(' | ')}

## 이번 패치 관련 변경사항
${relevantChanges.length > 0 ? relevantChanges.map((c) => `- ${c.name} (${c.type}): ${c.changes}`).join('\n') : '주력 챔피언 직접 변경 없음'}

## 아이템 변경
${(patchData.items || []).length > 0 ? patchData.items.map((i) => `- ${i.name}: ${i.changes}`).join('\n') : '주요 아이템 변경 없음'}

## 시스템 변경
${(patchData.systemChanges || []).length > 0 ? patchData.systemChanges.join('\n') : '없음'}

분석 형식:
## 🎮 플레이스타일 진단
(공격성/로밍/시야 수치를 종합한 한줄 요약 + 유형 분류)

## 📋 이번 패치가 너에게 미치는 영향
(주력 챔피언 변경사항이 플레이스타일과 어떻게 맞물리는지, 구체적으로)

## 🏆 이번 패치 추천 전략 (3개)
(플레이스타일에 맞는 패치 적응 방법, 각 1~2줄)

## 🔄 챔피언 풀 조언
(현재 챔피언 풀 기반 추가/교체 추천, 이유 포함)`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: COACH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].text;
  } catch (err) {
    console.error('AI 메타 분석 실패:', err.message);
    return getFallbackMetaAnalysis(playstyleProfile);
  }
}

// ============================================
// 🔄 폴백 함수
// ============================================
function getFallbackDecisionAnalysis(data) {
  const deathList = data.deathAnalysis
    .map(
      (d, i) =>
        `${i + 1}. ${d.minuteMark.toFixed(1)}분 — ${translateLocationType(d.locationType)} (${translateDeathContext(d.deathContext)})`
    )
    .join('\n');

  return `## 🔍 기본 분석 (AI 미사용)
${data.playerInfo.champion} (${translateRole(data.playerInfo.role)}) | ${data.playerInfo.kills}/${data.playerInfo.deaths}/${data.playerInfo.assists}

## ⚰️ 사망 기록
${deathList || '사망 없음'}

## 🎯 오브젝트 참여
참여율: ${data.objectiveParticipation.participationRate}%

## 📊 골드
10분 골드차: ${data.goldEfficiency.goldDiffAt10} | 15분 골드차: ${data.goldEfficiency.goldDiffAt15}

AI 분석을 사용할 수 없어 기본 데이터만 표시합니다.`;
}

function getFallbackMetaAnalysis(profile) {
  const champList = profile.championPool
    .map((c, i) => `${i + 1}. ${c.champion} (${c.games}판, ${c.winRate}%)`)
    .join('\n');

  return `## 🎮 플레이스타일 요약
승률: ${profile.winRate}% | KDA: ${profile.avgKDA}

## 🏆 주력 챔피언
${champList}

AI 분석을 사용할 수 없어 기본 프로필만 표시합니다.`;
}

// ============================================
// 📝 유틸리티: AI 응답 → Discord Embed 필드 파싱
// ============================================
function parseCoachingToFields(analysisText) {
  const sections = [];
  const lines = analysisText.split('\n');
  let currentSection = { title: '', content: '' };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection.title) {
        sections.push({ ...currentSection });
      }
      currentSection = { title: line.replace('## ', '').trim(), content: '' };
    } else if (line.trim()) {
      currentSection.content += line + '\n';
    }
  }

  if (currentSection.title) {
    sections.push(currentSection);
  }

  return sections
    .filter((s) => s.content.trim())
    .map((s) => ({
      name: s.title,
      value:
        s.content.trim().length > 1024
          ? s.content.trim().substring(0, 1021) + '...'
          : s.content.trim(),
    }));
}

// ============================================
// 🌐 번역 헬퍼
// ============================================
function translateLocationType(type) {
  const map = {
    LANE_SAFE: '라인 (안전)',
    LANE_OVEREXTENDED: '라인 (과확장)',
    RIVER: '리버',
    ENEMY_JUNGLE: '적 정글',
    OWN_JUNGLE: '아군 정글',
    ENEMY_BASE: '적 베이스',
    UNKNOWN: '알 수 없음',
  };
  return map[type] || type;
}

function translateDeathContext(ctx) {
  const map = {
    SOLO_DEATH: '솔로 데스',
    TEAMFIGHT_DEATH: '팀파이트',
    GANK_DEATH: '갱킹',
    DIVE_DEATH: '다이브',
  };
  return map[ctx] || ctx;
}

function translateRole(role) {
  const map = {
    TOP: '탑',
    JUNGLE: '정글',
    MIDDLE: '미드',
    BOTTOM: '원딜',
    UTILITY: '서포터',
    UNKNOWN: '알 수 없음',
    '': '알 수 없음',
  };
  return map[role] || role;
}

function translateMonsterType(type) {
  const map = {
    DRAGON: '드래곤',
    RIFTHERALD: '전령',
    BARON_NASHOR: '바론',
    ELDER_DRAGON: '장로 드래곤',
    HORDE: '공허충',
  };
  return map[type] || type;
}

module.exports = {
  analyzeDecisions,
  analyzeMetaImpact,
  parseCoachingToFields,
};
