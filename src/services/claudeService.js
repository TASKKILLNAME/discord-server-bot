// ============================================
// 🧠 Claude Service — AI 분석 + 사후 검증
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const { sanitizeForPrompt } = require('../utils/statNormalizer');

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

const MODEL = 'claude-sonnet-4-6';

// 사후 검증: 고elo 유저에게 부적절한 조언 감지
function validateResponse(text, tier) {
  const highElo = ['master', 'grandmaster', 'challenger'];
  if (!highElo.includes(tier.toLowerCase())) return text;

  const inappropriate = ['기초', '기본기가 부족', '기본부터'];
  const found = inappropriate.filter((w) => text.includes(w));

  if (found.length > 0) {
    console.warn(`[경고] 고elo 부적절 조언 감지: ${found.join(', ')} — 프롬프트 점검 필요`);
  }

  return text;
}

async function getMatchAnalysis(normalizedData, tier) {
  const anthropic = getClient();
  if (!anthropic) return getFallbackAnalysis(normalizedData);

  const sanitized = sanitizeForPrompt(normalizedData, tier);

  const systemPrompt = `당신은 리그 오브 레전드 고elo 전문 코치입니다.

[절대 금지]
- 절대 수치만 보고 판단 금지. 반드시 relative 점수 기준으로만 평가하세요
- 퍼센트/승률 수치 직접 생성 금지
- relative 점수가 ABOVE_AVG_SKIP인 항목은 언급 자체를 하지 마세요
- context_flags.is_dive = true인 챔피언의 KDA 지적 금지
- context_flags.is_roam = true인 챔피언의 CS 지적 금지
- 고elo(마스터 이상) 유저에게 '기초' 관련 조언 금지

[판단 기준]
- relative -1 이하 항목만 개선점으로 언급
- relative +1 이상 항목은 강점으로 인정
- 티어 맥락을 반드시 고려해서 조언 수준을 맞추세요

[출력 형식 - 반드시 준수]
**[티어 맥락]** 이 티어에서 이 데이터가 의미하는 바 한 줄
**[실제 강점]** relative 기준 잘하고 있는 것
**[진짜 개선점]** relative -1 이하 항목만, 챔피언 특성 고려
**[챔피언 풀 조언]** 현재 스타일과 데이터 기반으로
**[한줄 총평]** 20자 이내

한국어로 답하세요.`;

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(sanitized) }],
    });

    const text = res.content[0].text;
    return validateResponse(text, tier);
  } catch (err) {
    console.error('AI 매치 분석 실패:', err.message);
    return getFallbackAnalysis(normalizedData);
  }
}

async function getMetaCoaching(playStyle, patchChanges, tier) {
  const anthropic = getClient();
  if (!anthropic) return getFallbackMeta(playStyle);

  const systemPrompt = `당신은 리그 오브 레전드 메타 분석 전문가입니다.

[절대 금지]
- 퍼센트/승률 수치 직접 생성 금지
- relative 점수 ABOVE_AVG_SKIP 항목 언급 금지
- context_flags 무시하고 KDA/CS 지적 금지

[출력 형식]
**[성향 분석]** 한 줄 요약
**[이번 패치 핵심 변화]** 모스트 챔피언 기준으로만
**[권장 전략 변경]** 구체적 행동 지침 2~3개
**[챔피언 풀 조언]** 추가/제거 추천

한국어로 답하세요.`;

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify({ playStyle, patchChanges, tier }) }],
    });

    return validateResponse(res.content[0].text, tier);
  } catch (err) {
    console.error('AI 메타 분석 실패:', err.message);
    return getFallbackMeta(playStyle);
  }
}

// 폴백 함수
function getFallbackAnalysis(data) {
  return `**[티어 맥락]** AI 분석을 사용할 수 없어 기본 데이터만 표시합니다.
**[실제 강점]** ${data.champion} ${data.team_result}
**[진짜 개선점]** AI 분석 불가
**[한줄 총평]** 데이터 확인 필요`;
}

function getFallbackMeta(playStyle) {
  const champList = (playStyle.top_champions || [])
    .map((c, i) => `${i + 1}. ${c.name} (${c.games}판)`)
    .join('\n');

  return `**[성향 분석]** AI 분석을 사용할 수 없습니다.
**[모스트 챔피언]**
${champList || '데이터 없음'}`;
}

// AI 응답 → Discord Embed 필드 파싱
function parseAnalysisToFields(analysisText) {
  const sections = [];
  const lines = analysisText.split('\n');
  let currentSection = { title: '', content: '' };

  for (const line of lines) {
    const headerMatch = line.match(/^\*\*\[(.+?)\]\*\*/);
    if (headerMatch) {
      if (currentSection.title) {
        sections.push({ ...currentSection });
      }
      const afterHeader = line.replace(/^\*\*\[.+?\]\*\*\s*/, '').trim();
      currentSection = { title: headerMatch[1], content: afterHeader ? afterHeader + '\n' : '' };
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

module.exports = { getMatchAnalysis, getMetaCoaching, validateResponse, parseAnalysisToFields };
