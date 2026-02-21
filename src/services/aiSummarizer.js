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

/**
 * 패치노트를 AI로 요약
 * 챔피언 변경, 아이템 변경, 시스템 변경으로 분류
 */
async function summarizePatchNotes(patchData) {
  const anthropic = getClient();
  if (!anthropic) {
    return getFallbackSummary(patchData);
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `다음은 리그 오브 레전드(롤) 패치노트 내용입니다. 이 내용을 분석해서 아래 형식으로 한국어 요약을 작성해주세요.

**반드시 아래 형식을 지켜주세요:**

## 📋 패치 요약
(2-3줄로 이번 패치의 핵심 변경사항 요약)

## 🔺 버프 (상향)
(상향된 챔피언 목록과 핵심 변경사항. 없으면 "해당 없음")
- 챔피언이름: 변경 내용 요약

## 🔻 너프 (하향)  
(하향된 챔피언 목록과 핵심 변경사항. 없으면 "해당 없음")
- 챔피언이름: 변경 내용 요약

## 🔄 조정
(상향도 하향도 아닌 조정된 챔피언. 없으면 "해당 없음")
- 챔피언이름: 변경 내용 요약

## 🗡️ 아이템 변경
(변경된 아이템과 내용. 없으면 "해당 없음")

## 🛠️ 시스템 변경
(룬, 소환사 주문, 정글, 맵 등 시스템 변경사항. 없으면 "해당 없음")

## 🐛 버그 수정
(주요 버그 수정 사항. 없으면 "해당 없음")

## 🎨 스킨
(새로 출시되는 스킨. 없으면 "해당 없음")

**규칙:**
- 구체적인 수치(데미지, 쿨다운 등)가 있으면 포함
- 너무 길지 않게, 각 항목은 1-2줄로 요약
- 중요도가 높은 변경사항 위주로 정리
- 이모지를 적절히 활용

패치노트 내용:
${patchData.content}`,
        },
      ],
    });

    const summary = message.content[0].text;
    return summary;
  } catch (err) {
    console.error('AI 요약 실패:', err.message);
    return getFallbackSummary(patchData);
  }
}

/**
 * AI 실패 시 폴백 요약
 */
function getFallbackSummary(patchData) {
  const content = patchData.content;
  const preview = content.substring(0, 1500).replace(/\s+/g, ' ');

  return `## 📋 패치노트 요약 (자동 요약 실패 - 원문 일부)\n\n${preview}\n\n... 자세한 내용은 원문을 확인해주세요.`;
}

/**
 * 요약을 디스코드 Embed 형식으로 변환
 * 2000자 제한에 맞게 분할
 */
function formatForDiscord(summary, patchData) {
  const sections = [];
  const lines = summary.split('\n');

  let currentSection = { title: '', content: '' };

  for (const line of lines) {
    // ## 으로 시작하는 새 섹션 감지
    if (line.startsWith('## ')) {
      if (currentSection.title) {
        sections.push({ ...currentSection });
      }
      currentSection = {
        title: line.replace('## ', '').trim(),
        content: '',
      };
    } else if (line.trim()) {
      currentSection.content += line + '\n';
    }
  }

  // 마지막 섹션 추가
  if (currentSection.title) {
    sections.push(currentSection);
  }

  // Embed fields 생성 (각 필드 1024자 제한)
  const fields = sections
    .filter((s) => s.content.trim())
    .map((s) => ({
      name: s.title,
      value:
        s.content.trim().length > 1024
          ? s.content.trim().substring(0, 1021) + '...'
          : s.content.trim(),
    }));

  return {
    title: `📰 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0x1a78ae, // 롤 블루 컬러
    timestamp: new Date().toISOString(),
    footer: {
      text: '🤖 AI 요약 | 자세한 내용은 원문 확인',
    },
    thumbnail: {
      url: 'https://images.contentstack.io/v3/assets/blt731acb42bb3d1659/blt63f045f1aa0e2440/5ef1132f90d2de3ed4bbe867/LOL_PROMOART_2.jpg',
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
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

    const jsonStr = message.content[0].text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('패치 데이터 구조화 실패:', err.message);
    return null;
  }
}

module.exports = {
  summarizePatchNotes,
  formatForDiscord,
  extractStructuredPatchData,
};