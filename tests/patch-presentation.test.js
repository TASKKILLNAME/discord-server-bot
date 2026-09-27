const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');
const { loadWithMocks } = require('./helpers/load-with-mocks');
const { sectionFields, patchPayloads } = require('../src/services/patchLayout');
const ai = require('../src/services/aiSummarizer');
const patch = { title: '테스트 패치', url: 'https://example.com/patch', content: '원문' };

test('스킨·크로마는 독립 항목이며 빈 항목을 숨기고 강조를 유지한다', () => {
  const fields = sectionFields('## 🔻 하향\n해당 없음\n## 🎨 신규 스킨\n• **악의 여단** — 잔나\n## 🌈 신규 크로마\n• **고대 신** — 애니비아');
  assert.deepEqual(fields.map(f => f.name), ['🎨 신규 스킨', '🌈 신규 크로마']);
  assert.ok(fields.every(f => f.inline === false));
  assert.match(fields[0].value, /\*\*악의 여단\*\*/);
});

test('긴 요약은 6000자·25개 field 제한을 지키며 마지막 스킨까지 전송하고 링크 미리보기를 허용한다', () => {
  const fields = Array.from({ length: 30 }, (_, i) => ({ name: `변경 ${i}`, value: '가'.repeat(900), inline: false }));
  fields.push({ name: '🎨 신규 스킨', value: '마지막 스킨' });
  const payloads = patchPayloads({ ...ai.formatForDiscord('', patch), fields }, patch);
  assert.equal(payloads.flatMap(p => p.embeds?.flatMap(e => e.fields) || []).length, 31);
  for (const p of payloads.slice(0, -1)) {
    const e = new EmbedBuilder(p.embeds[0]);
    assert.ok(e.length <= 6000);
    assert.ok(e.data.fields.length <= 25);
    e.toJSON();
  }
  const link = payloads.at(-1);
  assert.equal(link.content, `📎 **원문 보기:** ${patch.url}`);
  assert.equal((link.flags || 0) & 4, 0);
});

test('수동 명령도 게임별 공통 레이아웃으로 모든 field와 원문 링크를 보낸다', async () => {
  const summary = Array.from({ length: 28 }, (_, i) => `## 항목 ${i}\n• **항목** — 내용`).join('\n');
  const scheduler = loadWithMocks(path.resolve(__dirname, '../src/services/unifiedPatchScheduler'), {
    './aiSummarizer': { ...ai, summarizePatchNotes: async () => summary, summarizeValorantPatchNotes: async () => summary, summarizeTftPatchNotes: async () => summary },
  });
  for (const game of ['lol', 'valorant', 'tft']) {
    const sent = [];
    await scheduler[game].sendPatchToChannel({ send: async p => sent.push(p) }, patch);
    assert.equal(sent.flatMap(p => p.embeds?.flatMap(e => e.fields) || []).length, 28);
    assert.equal(sent.at(-1).content, `📎 **원문 보기:** ${patch.url}`);
    assert.equal((sent.at(-1).flags || 0) & 4, 0);
  }
});

test('세 게임 crawler는 15000자 이후 스킨을 보존하고 관련 글은 제외한다', async () => {
  const html = `<article><h1>패치</h1><p>${'앞부분'.repeat(6000)}</p><h2>신규 스킨</h2><p>꼬리의 스킨</p><h2>관련 글</h2><p>이전 패치</p></article>`;
  for (const file of ['patchCrawler', 'valorantCrawler', 'tftCrawler']) {
    const crawler = loadWithMocks(path.resolve(__dirname, `../src/services/${file}`), { axios: { get: async () => ({ data: html }) } });
    const result = await crawler.crawlPatchContent(patch.url);
    assert.ok(result.content.length > 15000);
    assert.match(result.content, /꼬리의 스킨/);
    assert.doesNotMatch(result.content, /이전 패치/);
  }
});
