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

// ============================================
// TFT 패치노트 요약
// ============================================

async function summarizeTftPatchNotes(patchData) {
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
          content: `다음은 전략적 팀 전투(TFT) 패치노트 내용입니다. 이 내용을 분석해서 아래 형식으로 한국어 요약을 작성해주세요.

**반드시 아래 형식을 지켜주세요:**

## 📋 패치 요약
(2-3줄로 이번 TFT 패치의 핵심 변경사항 요약)

## 🔺 버프 (상향)
(상향된 챔피언/특성 목록. 없으면 "해당 없음")
- 이름: 변경 내용 요약

## 🔻 너프 (하향)
(하향된 챔피언/특성 목록. 없으면 "해당 없음")
- 이름: 변경 내용 요약

## 🔄 특성 변경
(특성(시너지) 변경사항. 없으면 "해당 없음")

## 🗡️ 아이템 변경
(변경된 아이템. 없으면 "해당 없음")

## 🌀 증강 변경
(증강체 변경사항. 없으면 "해당 없음")

## 🛠️ 시스템 변경
(상점, 골드, 레벨링 등 시스템 변경. 없으면 "해당 없음")

## 🐛 버그 수정
(주요 버그 수정. 없으면 "해당 없음")

**규칙:**
- 구체적인 수치가 있으면 포함 (예: "체력 800 → 900")
- 각 항목은 1-2줄로 요약
- 이모지를 적절히 활용

패치노트 내용:
${patchData.content}`,
        },
      ],
    });

    return message.content[0].text;
  } catch (err) {
    console.error('TFT AI 요약 실패:', err.message);
    return getFallbackSummary(patchData);
  }
}

function formatTftForDiscord(summary, patchData) {
  const sections = [];
  const lines = summary.split('\n');
  let currentSection = { title: '', content: '' };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection.title) sections.push({ ...currentSection });
      currentSection = { title: line.replace('## ', '').trim(), content: '' };
    } else if (line.trim()) {
      currentSection.content += line + '\n';
    }
  }
  if (currentSection.title) sections.push(currentSection);

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
    title: `🎮 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0xc89b3c, // TFT 골드 컬러
    timestamp: new Date().toISOString(),
    footer: { text: '🤖 AI 요약 | 자세한 내용은 원문 확인' },
    thumbnail: {
      url: 'https://images.contentstack.io/v3/assets/blt731acb42bb3d1659/bltc3572889a8f37be9/5fb56ca12ea50d5e4d7da47b/TFT_LOGO.png',
    },
  };
}

// ============================================
// Valorant 패치노트 요약
// ============================================

async function summarizeValorantPatchNotes(patchData) {
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
          content: `다음은 발로란트(VALORANT) 패치노트 내용입니다. 이 내용을 분석해서 아래 형식으로 한국어 요약을 작성해주세요.

**반드시 아래 형식을 지켜주세요:**

## 📋 패치 요약
(2-3줄로 이번 발로란트 패치의 핵심 변경사항 요약)

## 🔺 버프 (상향)
(상향된 요원/무기 목록. 없으면 "해당 없음")
- 이름: 변경 내용 요약

## 🔻 너프 (하향)
(하향된 요원/무기 목록. 없으면 "해당 없음")
- 이름: 변경 내용 요약

## 🧬 요원 변경
(기타 요원 조정. 없으면 "해당 없음")
- 요원이름: 변경 내용 요약

## 🔫 무기 변경
(무기 밸런스 변경. 없으면 "해당 없음")

## 🗺️ 맵 변경
(맵 업데이트. 없으면 "해당 없음")

## 🛠️ 게임 시스템 변경
(경제, 스파이크, 커리어 등 시스템 변경. 없으면 "해당 없음")

## 🐛 버그 수정
(주요 버그 수정. 없으면 "해당 없음")

**규칙:**
- 구체적인 수치가 있으면 포함
- 각 항목은 1-2줄로 요약
- 이모지를 적절히 활용

패치노트 내용:
${patchData.content}`,
        },
      ],
    });

    return message.content[0].text;
  } catch (err) {
    console.error('Valorant AI 요약 실패:', err.message);
    return getFallbackSummary(patchData);
  }
}

function formatValorantForDiscord(summary, patchData) {
  const sections = [];
  const lines = summary.split('\n');
  let currentSection = { title: '', content: '' };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection.title) sections.push({ ...currentSection });
      currentSection = { title: line.replace('## ', '').trim(), content: '' };
    } else if (line.trim()) {
      currentSection.content += line + '\n';
    }
  }
  if (currentSection.title) sections.push(currentSection);

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
    title: `🔫 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0xff4655, // 발로란트 레드 컬러
    timestamp: new Date().toISOString(),
    footer: { text: '🤖 AI 요약 | 자세한 내용은 원문 확인' },
    thumbnail: {
      url: 'https://images.contentstack.io/v3/assets/bltb6530b271fddd0b1/blt8a9da6d9e84cdee7/5f7a73cc64c8cc5c26fc4ac5/VALORANT_logo_image.jpg',
    },
  };
}

// ============================================
// 타르코프 패치노트 요약
// ============================================

async function summarizeTarkovPatchNotes(patchData) {
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
          content: `다음은 Escape from Tarkov(타르코프) 패치노트 내용입니다. 러시아어인 경우 한국어로 번역해주세요. 아래 형식으로 한국어 요약을 작성해주세요.

**반드시 아래 형식을 지켜주세요:**

## 📋 패치 요약
(2-3줄로 이번 패치의 핵심 변경사항 요약)

## 🔫 무기/장비 변경
(무기, 탄약, 장비 변경사항. 없으면 "해당 없음")
- 이름: 변경 내용 요약

## 🗺️ 맵 변경
(맵 관련 변경사항. 없으면 "해당 없음")

## 🎯 게임플레이 변경
(레이드, 퀘스트, 스캐브, PMC 관련 변경. 없으면 "해당 없음")

## 💰 경제/거래 변경
(플리마켓, 딜러, 가격 변경. 없으면 "해당 없음")

## 🛡️ 안티치트/보안
(안티치트, 밴 관련. 없으면 "해당 없음")

## 🛠️ 최적화/기술
(성능 개선, 서버, 네트코드 변경. 없으면 "해당 없음")

## 🐛 버그 수정
(주요 버그 수정. 없으면 "해당 없음")

**규칙:**
- 구체적인 수치가 있으면 포함
- 각 항목은 1-2줄로 요약
- 이모지를 적절히 활용
- 러시아어 원문은 반드시 한국어로 번역

패치노트 내용:
${patchData.content}`,
        },
      ],
    });

    return message.content[0].text;
  } catch (err) {
    console.error('타르코프 AI 요약 실패:', err.message);
    return getFallbackSummary(patchData);
  }
}

function formatTarkovForDiscord(summary, patchData) {
  const sections = [];
  const lines = summary.split('\n');
  let currentSection = { title: '', content: '' };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection.title) sections.push({ ...currentSection });
      currentSection = { title: line.replace('## ', '').trim(), content: '' };
    } else if (line.trim()) {
      currentSection.content += line + '\n';
    }
  }
  if (currentSection.title) sections.push(currentSection);

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
    title: `🎮 ${patchData.title}`,
    url: patchData.url,
    fields,
    color: 0x1a1a1a, // 타르코프 다크 컬러
    timestamp: new Date().toISOString(),
    footer: { text: '🤖 AI 요약 | 자세한 내용은 원문 확인' },
    thumbnail: {
      url: 'https://upload.wikimedia.org/wikipedia/en/thumb/2/28/Escape_from_Tarkov_logo.png/250px-Escape_from_Tarkov_logo.png',
    },
  };
}

module.exports = {
  summarizePatchNotes,
  formatForDiscord,
  extractStructuredPatchData,
  summarizeTftPatchNotes,
  formatTftForDiscord,
  summarizeValorantPatchNotes,
  formatValorantForDiscord,
  summarizeTarkovPatchNotes,
  formatTarkovForDiscord,
};