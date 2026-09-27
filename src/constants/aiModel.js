// ============================================
// 🤖 Anthropic 모델 ID (전 서비스 공용)
// ============================================

// 모델 ID는 반드시 여기서만 관리한다.
// 이전에 7개 호출부에 하드코딩돼 있어, 모델이 은퇴했을 때
// 전부 404가 나는데도 각 서비스의 catch 폴백이 이를 삼켜버렸다.
const AI_MODEL = 'claude-sonnet-5';

// 응답에서 텍스트만 꺼낸다.
// 최신 모델은 content[0]이 thinking 블록일 수 있어 content[0].text가 undefined가 된다.
function getResponseText(message) {
  const text = (message?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) {
    throw new Error(`AI 응답에 텍스트가 없습니다 (stop_reason: ${message?.stop_reason})`);
  }
  return text;
}

module.exports = { AI_MODEL, getResponseText };
