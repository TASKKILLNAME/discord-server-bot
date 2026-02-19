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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `당신은 리그 오브 레전드 전문 분석가입니다. 아래 실시간 게임 데이터를 분석해주세요.

**🔵 블루팀:**
${blueTeamStr}

**🔴 레드팀:**
${redTeamStr}

다음 형식으로 분석해주세요:

## 🔍 팀 구성 분석
(각 팀의 구성 특징: 딜러/탱커/서포터 비율, 팀파이트 vs 스플릿 등)

## 📊 승리 예측
(승률 예측과 근거 - 예: "블루팀 55% : 레드팀 45%")

## ⚔️ 핵심 매치업
(가장 중요한 매치업 2-3개와 주의할 점)

## 💡 전략 조언
(이기기 위한 핵심 전략 2-3개)

**규칙:**
- 각 섹션은 2-4줄로 간결하게
- 챔피언 이름은 한국어로
- 랭크 정보를 바탕으로 실력 차이도 분석
- 이모지를 적절히 활용
- 친근하고 실용적인 톤으로`,
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

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `당신은 리그 오브 레전드 전문 분석가입니다. 아래 최근 전적 데이터를 분석해주세요.

**소환사 정보:**
닉네임: ${matchData.account.gameName}#${matchData.account.tagLine}
랭크: ${matchData.rank}
레벨: ${matchData.summonerLevel}

**최근 ${matchData.matches.length}게임 전적:**
${matchesStr}

다음 형식으로 분석해주세요:

## 📈 종합 성적
(승률, 평균 KDA, 가장 많이 플레이한 챔피언 등 핵심 통계)

## 🎯 챔피언 풀 분석
(주로 사용하는 챔피언과 역할, 숙련도 평가)

## 💪 강점
(데이터에서 보이는 강점 2-3개)

## 📝 개선점
(데이터에서 보이는 약점과 구체적 개선 방법 2-3개)

## ⭐ 종합 평가
(한 줄 종합 평가)

**규칙:**
- 각 섹션은 2-4줄로 간결하게
- 구체적 수치를 활용해서 분석
- 건설적이고 긍정적인 톤
- 이모지를 적절히 활용
- 실질적으로 도움이 되는 조언`,
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
