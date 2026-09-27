const { buildSummaryPrompt, sectionFields } = require('./patchLayout');
const Anthropic = require('@anthropic-ai/sdk');
const { AI_MODEL, getResponseText } = require('../constants/aiModel');

// 요약 실패 시 앞에 붙는 표식. 스케줄러가 이걸로 실패를 감지해
// "AI가 요약했습니다" 문구 대신 실패 안내를 띄운다.
const SUMMARY_FAILED_MARKER = '## ⚠️ AI 요약 실패';

const MAX_ATTEMPTS = 3;

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

/**
 * Claude 호출 + 재시도. 실패하면 마지막 에러를 throw한다.
 * 429/5xx/네트워크만 재시도하고, 404(은퇴 모델)·401 같은 영구 오류는 즉시 포기.
 */
async function callClaude(anthropic, prompt, label) {
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 8000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      });
      return getResponseText(message);
    } catch (err) {
      lastErr = err;
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      console.error(
        `❌ [${label}] AI 요약 호출 실패 (${attempt}/${MAX_ATTEMPTS}) ` +
          `model=${AI_MODEL} status=${err.status} type=${err.type}: ${err.message}`
      );
      if (!retryable) break;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  throw lastErr;
}

/**
 * 패치노트를 AI로 요약
 * 챔피언 변경, 아이템 변경, 시스템 변경으로 분류
 */
async function summarizePatchNotes(patchData) {
  const anthropic = getClient();
  if (!anthropic) {
    return getFallbackSummary('ANTHROPIC_API_KEY가 설정되지 않았습니다');
  }

  const prompt = buildSummaryPrompt('lol', patchData);

  try {
    return await callClaude(anthropic, prompt, '롤');
  } catch (err) {
    return getFallbackSummary(`${err.status || 'network'} — ${err.message}`);
  }
}

/**
 * AI 실패 시 폴백. 원문을 그대로 쏟아내지 않고 실패를 명시한다.
 * 예전엔 영문 원문 1500자를 붙여 보내서, 모델 오류가 "요약이 좀 이상한 글"처럼 보였다.
 */
function getFallbackSummary(reason) {
  return (
    `${SUMMARY_FAILED_MARKER}\n\n` +
    `AI 요약을 생성하지 못했습니다. 아래 **원문 보기** 링크를 확인해주세요.\n` +
    `사유: \`${reason}\``
  );
}

/**
 * 요약을 디스코드 Embed 형식으로 변환
 * 2000자 제한에 맞게 분할
 */
function formatForDiscord(summary, patchData) {
  const fields = sectionFields(summary);

  return {
    title: `📰 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0x1a78ae, // 롤 블루 컬러
    timestamp: new Date().toISOString(),
    footer: {
      text: '🤖 AI 요약 | 자세한 내용은 원문 확인',
    },
  };
}

/**
 * 패치노트에서 구조화된 데이터 추출 (patch.json용)
 * 챔피언/아이템/시스템 변경사항을 JSON으로 분리
 */
async function extractStructuredPatchData(patchData) {
  const anthropic = getClient();
  if (!anthropic) return null;

  try {
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 8000,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: `다음 패치노트에서 챔피언 변경사항, 아이템 변경사항, 시스템 변경사항을 JSON으로 추출해라.
반드시 아래 JSON 형식으로만 응답해라 (설명 없이 순수 JSON만):

{
  "champions": [{"name": "챔피언명(한글)", "type": "buff|nerf|adjust", "changes": "변경 요약(수치 포함)"}],
  "items": [{"name": "아이템명(한글)", "changes": "변경 요약(수치 포함)"}],
  "systemChanges": ["변경사항1", "변경사항2"]
}

규칙:
- champions의 name은 한글 챔피언명 사용 (아리, 징크스, 야스오 등)
- type은 buff(상향), nerf(하향), adjust(조정) 중 하나
- 수치 변경이 있으면 반드시 포함 (예: "Q 데미지 70 → 80")
- 변경이 없는 카테고리는 빈 배열 []

패치노트:
${patchData.content}`,
        },
      ],
    });

    const jsonStr = getResponseText(message)
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    return JSON.parse(jsonStr);
  } catch (err) {
    console.error(
      `패치 데이터 구조화 실패: model=${AI_MODEL} status=${err.status} type=${err.type}: ${err.message}`
    );
    return null;
  }
}

// ============================================
// TFT 패치노트 요약
// ============================================

async function summarizeTftPatchNotes(patchData) {
  const anthropic = getClient();
  if (!anthropic) {
    return getFallbackSummary('ANTHROPIC_API_KEY가 설정되지 않았습니다');
  }

  const prompt = buildSummaryPrompt('tft', patchData);

  try {
    return await callClaude(anthropic, prompt, 'TFT');
  } catch (err) {
    return getFallbackSummary(`${err.status || 'network'} — ${err.message}`);
  }
}

function formatTftForDiscord(summary, patchData) {
  const fields = sectionFields(summary);

  return {
    title: `🎮 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0xc89b3c, // TFT 골드 컬러
    timestamp: new Date().toISOString(),
    footer: { text: '🤖 AI 요약 | 자세한 내용은 원문 확인' },
  };
}

// ============================================
// Valorant 패치노트 요약
// ============================================

async function summarizeValorantPatchNotes(patchData) {
  const anthropic = getClient();
  if (!anthropic) {
    return getFallbackSummary('ANTHROPIC_API_KEY가 설정되지 않았습니다');
  }

  const prompt = buildSummaryPrompt('valorant', patchData);

  try {
    return await callClaude(anthropic, prompt, '발로란트');
  } catch (err) {
    return getFallbackSummary(`${err.status || 'network'} — ${err.message}`);
  }
}

function formatValorantForDiscord(summary, patchData) {
  const fields = sectionFields(summary);

  return {
    title: `🔫 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0xff4655, // 발로란트 레드 컬러
    timestamp: new Date().toISOString(),
    footer: { text: '🤖 AI 요약 | 자세한 내용은 원문 확인' },
  };
}

module.exports = {
  SUMMARY_FAILED_MARKER,
  summarizePatchNotes,
  formatForDiscord,
  extractStructuredPatchData,
  summarizeTftPatchNotes,
  formatTftForDiscord,
  summarizeValorantPatchNotes,
  formatValorantForDiscord,
};