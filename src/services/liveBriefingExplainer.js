const Anthropic = require('@anthropic-ai/sdk');
const { AI_MODEL, getResponseText } = require('../constants/aiModel');

// ============================================
// 🗣️ 브리핑 설명 계층 (선택)
//
// AI는 코드가 확정한 주의할 점·운영 선택지를 짧게 다듬기만 한다.
// 입력에는 이름·PUUID·Discord ID 없이 가명(ME, ENEMY_LANE ...)과 사실 ID만 넣는다.
// 출력이 검증을 하나라도 통과하지 못하면 전부 버리고 코드 템플릿 문장을 쓴다.
// ============================================

const EXPLAINER_CONFIG = Object.freeze({
  timeoutMs: 12000,
  maxTextLength: 140,
  maxTokens: 800,
});

// 확률·승률 예측, 링크·멘션, 내부 가명 노출 금지
const FORBIDDEN_PATTERNS = [
  /%/,
  /퍼센트/,
  /확률/,
  /승률/,
  /승리\s*예측/,
  /https?:|www\./i,
  /<[@#&!]|@everyone|@here/,
  /\b(ME|ALLY|ENEMY)_[A-Z_]+\b/,
  /\bF\d+\b|\b[CO]\d+\b/,
];

let clientFactory = () => (process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null);

function numbersIn(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) || []);
}

/**
 * AI 응답 검증. 통과하면 { ok: true, texts: Map(id → text) }, 아니면 { ok: false, reason }
 * - JSON 구조, id 집합이 템플릿과 정확히 일치
 * - 길이 제한, 금지 표현
 * - 문장 속 숫자는 그 항목의 원문·참조 사실에 있는 숫자만 허용
 */
function validateExplanation(raw, content) {
  let parsed;
  try {
    const jsonText = String(raw).replace(/```json\s*|```/g, '').trim();
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'JSON 파싱 실패' };
  }
  if (!parsed || !Array.isArray(parsed.items)) return { ok: false, reason: 'items 없음' };

  const expected = new Map([...content.cautions, ...content.options].map((item) => [item.id, item]));
  const factText = new Map(content.facts.map((f) => [f.id, f.text]));
  const texts = new Map();

  for (const out of parsed.items) {
    if (!out || typeof out.id !== 'string' || typeof out.text !== 'string') return { ok: false, reason: '항목 형식 오류' };
    const item = expected.get(out.id);
    if (!item) return { ok: false, reason: `알 수 없는 id ${out.id}` };
    if (texts.has(out.id)) return { ok: false, reason: `중복 id ${out.id}` };
    const text = out.text.trim();
    if (!text || text.length > EXPLAINER_CONFIG.maxTextLength) return { ok: false, reason: `${out.id} 길이 초과` };
    const forbidden = FORBIDDEN_PATTERNS.find((p) => p.test(text));
    if (forbidden) return { ok: false, reason: `${out.id} 금지 표현` };

    const allowed = new Set(numbersIn([item.text, ...item.factIds.map((id) => factText.get(id) || '')].join(' ')));
    const unknownNumber = numbersIn(text).find((n) => !allowed.has(n));
    if (unknownNumber) return { ok: false, reason: `${out.id} 입력에 없는 수치 ${unknownNumber}` };
    texts.set(out.id, text);
  }
  if (texts.size !== expected.size) return { ok: false, reason: '누락된 항목' };
  return { ok: true, texts };
}

function buildPrompt(content) {
  const payload = {
    facts: content.facts.map((f) => ({ id: f.id, subject: f.subject, text: f.text })),
    items: [...content.cautions, ...content.options].map((item) => ({
      id: item.id,
      kind: item.id.startsWith('C') ? 'caution' : 'option',
      draft: item.text,
      factIds: item.factIds,
    })),
  };
  return [
    '리그 오브 레전드 게임 시작 브리핑 문장을 다듬는다.',
    '규칙:',
    '- 각 item의 draft를 같은 의미로 더 짧고 자연스러운 한국어 한 문장으로 바꾼다.',
    '- draft와 그 factIds의 사실에 없는 내용·숫자·스킬 수치·플레이어 성향을 추가하지 않는다.',
    '- 승률·확률·퍼센트·승리 예측을 쓰지 않는다. 링크·멘션·ID(F1, C1, ME 등)를 문장에 쓰지 않는다.',
    '- 현재 게임에서 이미 일어난 일처럼 쓰지 않는다.',
    `- 각 문장은 ${EXPLAINER_CONFIG.maxTextLength}자 이하.`,
    '- 모든 item을 빠짐없이, 아래 JSON 형식으로만 답한다: {"items":[{"id":"C1","text":"..."}]}',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

/**
 * content: buildBriefContent 결과. 반환: { status: 'ai'|'template'|'skipped', reason, texts: Map|null }
 * 어떤 경우에도 예외를 던지지 않는다.
 */
async function explainBriefContent(content, { timeoutMs = EXPLAINER_CONFIG.timeoutMs } = {}) {
  if (!content || content.cautions.length + content.options.length === 0) {
    return { status: 'skipped', reason: '설명할 항목 없음', texts: null };
  }
  if (process.env.LIVE_BRIEFING_AI === 'off') return { status: 'skipped', reason: 'AI 설명 꺼짐', texts: null };

  let client;
  try {
    client = clientFactory();
  } catch {
    client = null;
  }
  if (!client) return { status: 'skipped', reason: 'AI 키 없음', texts: null };

  try {
    const message = await client.messages.create(
      {
        model: AI_MODEL,
        max_tokens: EXPLAINER_CONFIG.maxTokens,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: buildPrompt(content) }],
      },
      { timeout: timeoutMs, maxRetries: 0 }
    );
    const result = validateExplanation(getResponseText(message), content);
    if (!result.ok) {
      console.error(`브리핑 AI 설명 검증 실패: ${result.reason}`);
      return { status: 'template', reason: result.reason, texts: null };
    }
    return { status: 'ai', reason: null, texts: result.texts };
  } catch (err) {
    console.error(`브리핑 AI 설명 실패: ${err.name || 'Error'} ${err.status || ''} ${err.message}`.trim());
    return { status: 'template', reason: 'AI 호출 실패', texts: null };
  }
}

module.exports = {
  EXPLAINER_CONFIG,
  validateExplanation,
  buildPrompt,
  explainBriefContent,
  __testing: {
    setClientFactory(fn) {
      clientFactory = fn;
    },
  },
};
