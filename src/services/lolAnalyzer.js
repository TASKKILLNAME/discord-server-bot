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

// ============================================
// 🎮 실시간 게임 AI 분석
// ============================================
async function analyzeLiveGame(gameData) {
  const anthropic = getClient();
  if (!anthropic) {
    return getFallbackLiveAnalysis(gameData);
  }

  // 팀 데이터 포맷
  const blueTeamStr = gameData.blueTeam
    .map((p, i) => `  ${i + 1}. ${p.championName} | ${p.rank} | ${p.spell1}/${p.spell2}`)
    .join('\n');

  const redTeamStr = gameData.redTeam
    .map((p, i) => `  ${i + 1}. ${p.championName} | ${p.rank} | ${p.spell1}/${p.spell2}`)
    .join('\n');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `리그 오브 레전드 실시간 게임 데이터. 서론 없이 바로 분석.

🔵 블루팀:
${blueTeamStr}

🔴 레드팀:
${redTeamStr}

분석 지침:
- 솔로랭크 티어 기준으로 실력 차이 평가
- 팀 구성의 승리 조건과 패배 조건을 명확히
- 라인전 매치업에서 누가 유리한지 구체적으로
- 서론/인사 없이 바로 핵심만

다음 형식으로:

## 🔍 팀 구성 분석
(딜 구성, 탱/딜 비율, 팀파이트 vs 스플릿 한줄씩)

## 📊 승리 예측
(블루 vs 레드 %와 핵심 근거 2줄)

## ⚔️ 핵심 매치업
(라인별 유불리 + 주의할 매치업, 각 1줄)

## 💡 이기려면
(각 팀이 이기는 시나리오, 각 2줄 이내)`,
        },
      ],
    });

    return message.content[0].text;
  } catch (err) {
    console.error('AI 실시간 분석 실패:', err.message);
    return getFallbackLiveAnalysis(gameData);
  }
}

// ============================================
// 📊 최근 전적 AI 분석
// ============================================
async function analyzeRecentMatches(matchData) {
  const anthropic = getClient();
  if (!anthropic) {
    return getFallbackMatchAnalysis(matchData);
  }

  const matchesStr = matchData.matches
    .map(
      (m, i) =>
        `  ${i + 1}. ${m.win ? '승리' : '패배'} | ${m.champion} (${m.teamPosition}) | ${m.kills}/${m.deaths}/${m.assists} (KDA ${m.kda}) | CS ${m.cs} (${m.csPerMin}/분) | 피해량 ${m.damage.toLocaleString()} | ${m.duration}`
    )
    .join('\n');

  // 승/패 분리 통계 계산
  const wins = matchData.matches.filter((m) => m.win);
  const losses = matchData.matches.filter((m) => !m.win);
  const total = matchData.matches.length;
  const winRate = total > 0 ? Math.round((wins.length / total) * 100) : 0;

  const avgKills = (matchData.matches.reduce((s, m) => s + m.kills, 0) / total).toFixed(1);
  const avgDeaths = (matchData.matches.reduce((s, m) => s + m.deaths, 0) / total).toFixed(1);
  const avgAssists = (matchData.matches.reduce((s, m) => s + m.assists, 0) / total).toFixed(1);
  const avgCs = (matchData.matches.reduce((s, m) => s + parseFloat(m.csPerMin), 0) / total).toFixed(1);
  const avgDmg = Math.round(matchData.matches.reduce((s, m) => s + m.damage, 0) / total);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `분석할 유저 데이터:
닉네임: ${matchData.account.gameName}#${matchData.account.tagLine}
솔로랭크: ${matchData.rank}
최근 ${total}게임: ${wins.length}승 ${losses.length}패 (${winRate}%)
평균: ${avgKills}/${avgDeaths}/${avgAssists} KDA | CS ${avgCs}/분 | 피해량 ${avgDmg.toLocaleString()}

매치 데이터:
${matchesStr}

분석 지침:
- CS/분, KDA, 피해량, 게임시간을 같은 티어 평균과 비교해서 평가할 것
- 이기는 게임과 지는 게임의 패턴 차이를 반드시 짚을 것
- 챔피언별로 플레이 스타일 차이가 보이면 언급할 것
- 서론/인사 없이 바로 핵심만, 수치 근거 필수
- 마지막엔 "다음 게임에서 딱 한 가지만 고친다면" 으로 마무리할 것

다음 형식으로:

## 📈 종합 성적
(핵심 수치 요약, 2-3줄)

## 🎯 챔피언 풀 분석
(챔피언별 특징, 플레이 스타일 차이, 2-3줄)

## 💪 강점
(데이터 근거 + 같은 티어 대비 잘하는 점, 2개)

## 📝 개선점
(원인 + 해결책 세트로, 최대 2개)

## 📊 수치 분석
(같은 티어 평균 대비 CS/분, KDA, 피해량 등 구체 비교)

## ⭐ 다음 게임에서 딱 한 가지만 고친다면
(가장 임팩트 큰 개선점 1개, 구체적 실천법)`,
        },
      ],
    });

    return message.content[0].text;
  } catch (err) {
    console.error('AI 전적 분석 실패:', err.message);
    return getFallbackMatchAnalysis(matchData);
  }
}

// ============================================
// 🔄 폴백 함수 (AI 실패 시)
// ============================================
function getFallbackLiveAnalysis(gameData) {
  const blue = gameData.blueTeam.map((p) => `• ${p.championName} (${p.rank})`).join('\n');
  const red = gameData.redTeam.map((p) => `• ${p.championName} (${p.rank})`).join('\n');

  return `## 🔵 블루팀\n${blue}\n\n## 🔴 레드팀\n${red}\n\n## 📊 분석\nAI 분석을 사용할 수 없어 기본 정보만 표시합니다.`;
}

function getFallbackMatchAnalysis(matchData) {
  const wins = matchData.matches.filter((m) => m.win).length;
  const total = matchData.matches.length;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  const avgKills = (matchData.matches.reduce((s, m) => s + m.kills, 0) / total).toFixed(1);
  const avgDeaths = (matchData.matches.reduce((s, m) => s + m.deaths, 0) / total).toFixed(1);
  const avgAssists = (matchData.matches.reduce((s, m) => s + m.assists, 0) / total).toFixed(1);

  return `## 📈 종합 성적\n${total}게임 ${wins}승 ${total - wins}패 (승률 ${winRate}%)\n평균 KDA: ${avgKills}/${avgDeaths}/${avgAssists}\n\n## 📊 분석\nAI 분석을 사용할 수 없어 기본 통계만 표시합니다.`;
}

// ============================================
// 📝 AI 응답 → Discord Embed 필드 파싱
// ============================================
function parseAnalysisToFields(analysisText) {
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

module.exports = {
  analyzeLiveGame,
  analyzeRecentMatches,
  parseAnalysisToFields,
};
