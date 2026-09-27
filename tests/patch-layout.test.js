'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { createRequire } = require('node:module');

const PROJECT_ROOT = path.resolve(__dirname, '..');

test.beforeEach((t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
});

/**
 * CommonJS 모듈을 실제 network/DB 대신 지정한 stub으로 로드한다.
 * production module cache를 건드리지 않아 테스트끼리 상태가 섞이지 않는다.
 */
function loadModule(relativePath, mocks = {}) {
  const filename = path.join(PROJECT_ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = createRequire(filename);
  const testModule = { exports: {} };

  function requireWithMocks(request) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return localRequire(request);
  }

  const wrapper = new vm.Script(Module.wrap(source), { filename }).runInThisContext();
  wrapper.call(
    testModule.exports,
    testModule.exports,
    requireWithMocks,
    testModule,
    filename,
    path.dirname(filename)
  );
  return testModule.exports;
}

function createLolCrawlerFixture({
  lastUrl = null,
  latestUrl = 'https://www.leagueoflegends.com/ko-kr/news/game-updates/patch-25-18-notes/',
  saveError = null,
  beforeSelectReturn = null,
} = {}) {
  let state = lastUrl
    ? { lastUrl, lastTitle: '이전 패치' }
    : null;
  const calls = { list: 0, detail: 0, select: 0, insert: 0 };
  const articleBody = Array.from(
    { length: 60 },
    (_, index) => `챔피언 ${index + 1}의 능력치가 조정되었습니다.`
  ).join(' ');

  const axios = {
    async get(url) {
      if (url.includes('/news/tags/patch-notes/')) {
        calls.list++;
        return {
          data: `<a href="${latestUrl}"><h2>25.18 패치노트</h2></a>`,
        };
      }

      calls.detail++;
      return {
        data: `<article><h1>25.18 패치노트</h1><p>${articleBody}</p></article>`,
      };
    },
  };

  const pool = {
    async query(sql, params) {
      if (/^\s*SELECT/i.test(sql)) {
        calls.select++;
        const snapshot = state
          ? [{ last_url: state.lastUrl, last_title: state.lastTitle }]
          : [];
        if (beforeSelectReturn) await beforeSelectReturn();
        return { rows: snapshot };
      }

      if (/^\s*INSERT/i.test(sql)) {
        calls.insert++;
        if (saveError) throw saveError;
        state = { lastUrl: params[1], lastTitle: params[2] };
        return { rows: [] };
      }

      throw new Error(`예상하지 못한 SQL: ${sql}`);
    },
  };

  const crawler = loadModule('src/services/patchCrawler.js', {
    axios,
    '../db': { pool },
  });

  return { crawler, calls, getState: () => state };
}

function createBarrier(expectedArrivals) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });

  return async () => {
    arrivals++;
    if (arrivals === expectedArrivals) release();
    await ready;
  };
}

function loadAiSummarizerWithoutApiKey() {
  return loadModule('src/services/aiSummarizer.js', {
    '@anthropic-ai/sdk': class AnthropicMustNotBeCreated {
      constructor() {
        throw new Error('fallback 테스트에서 Anthropic client를 생성하면 안 됩니다.');
      }
    },
    '../constants/aiModel': { AI_MODEL: 'offline-test-model' },
  });
}

class FakeEmbedBuilder {
  toJSON() { return this.data; }
  constructor() {
    this.data = { fields: [] };
  }

  setTitle(value) {
    this.data.title = value;
    return this;
  }

  setDescription(value) {
    this.data.description = value;
    return this;
  }

  setURL(value) {
    this.data.url = value;
    return this;
  }

  setColor(value) {
    this.data.color = value;
    return this;
  }

  setTimestamp() {
    this.data.timestamp = true;
    return this;
  }

  setFooter(value) {
    this.data.footer = value;
    return this;
  }

  setThumbnail(value) {
    this.data.thumbnail = { url: value };
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }
}

function createSchedulerHarness({ summary, embedData, startupLastUrls = {} }) {
  const patchData = {
    title: '25.18 패치노트',
    url: 'https://example.invalid/patch-25-18',
    content: 'RAW_SCHEDULER_PATCH_CONTENT',
  };
  const sent = [];
  const startupSaves = [];
  const delivered = new Set();
  for (const game of ['lol', 'valorant', 'tft']) {
    if (!startupLastUrls[game]) delivered.add(`https://example.invalid/${game}/current`);
  }
  let scheduledCallback = null;

  const channel = {
    async send(payload) {
      sent.push(payload);
    },
  };

  const calls = {};
  const makeCrawler = (game, hasPatch) => ({
    async getLatestPatchUrl() {
      calls[game] = (calls[game] || 0) + 1;
      if (game === 'lol' && calls[game] > 1) return { url: patchData.url, title: patchData.title };
      return { url: `https://example.invalid/${game}/current`, title: `${game} current` };
    },
    async crawlPatchContent() { return patchData; },
    async loadLastPatch() {
      const currentUrl = `https://example.invalid/${game}/current`;
      return {
        lastUrl: Object.prototype.hasOwnProperty.call(startupLastUrls, game)
          ? startupLastUrls[game]
          : currentUrl,
        lastTitle: `${game} previous`,
      };
    },
    async saveLastPatch(data) {
      startupSaves.push({ game, ...data });
    },
    async checkForNewPatch() {
      return hasPatch ? patchData : null;
    },
    async forceGetLatestPatch() {
      return patchData;
    },
  });

  const lolCrawler = makeCrawler('lol', true);
  const valorantCrawler = makeCrawler('valorant', false);
  const tftCrawler = makeCrawler('tft', false);

  const scheduler = loadModule('src/services/unifiedPatchScheduler.js', {
    './patchDelivery': {
      canonicalUrl: value => value,
      async deliverPatch(game, channel, url, build) {
        if (delivered.has(url)) return true;
        for (const payload of await build()) {
          await channel.send(payload.content || { embeds: payload.embeds.map(data => ({ data })) });
        }
        delivered.add(url);
        return true;
      },
    },
    'node-cron': {
      schedule(_expression, callback) {
        scheduledCallback = callback;
        return { stop() {} };
      },
    },
    'discord.js': { EmbedBuilder: FakeEmbedBuilder },
    '../db': {
      pool: {
        async query(sql, params) {
          if (/INSERT INTO patch_state/.test(sql)) return { rows: [] };
          if (/SELECT guild_id, channel_id FROM patch_channels/i.test(sql)) {
            return params[0] === 'lol'
              ? { rows: [{ guild_id: 'guild-1', channel_id: 'channel-1' }] }
              : { rows: [] };
          }
          throw new Error(`예상하지 못한 scheduler SQL: ${sql}`);
        },
      },
    },
    './patchCrawler': lolCrawler,
    './valorantCrawler': valorantCrawler,
    './tftCrawler': tftCrawler,
    './aiSummarizer': {
      SUMMARY_FAILED_MARKER: '## ⚠️ AI 요약 실패',
      async summarizePatchNotes() {
        return summary;
      },
      formatForDiscord() {
        return embedData;
      },
      async extractStructuredPatchData() {
        return null;
      },
      async summarizeTftPatchNotes() {
        throw new Error('TFT 요약은 호출되면 안 됩니다.');
      },
      formatTftForDiscord() {
        throw new Error('TFT formatter는 호출되면 안 됩니다.');
      },
      async summarizeValorantPatchNotes() {
        throw new Error('Valorant 요약은 호출되면 안 됩니다.');
      },
      formatValorantForDiscord() {
        throw new Error('Valorant formatter는 호출되면 안 됩니다.');
      },
    },
  });

  const client = {
    channels: {
      async fetch(channelId) {
        assert.equal(channelId, 'channel-1');
        return channel;
      },
    },
  };

  return {
    scheduler,
    client,
    sent,
    startupSaves,
    patchData,
    getScheduledCallback: () => scheduledCallback,
  };
}

test('시작 시 봇이 꺼진 사이 올라온 패치를 전송한다', async () => {
  const harness = createSchedulerHarness({
    summary: '## 📋 패치 요약\n정상 요약',
    embedData: {
      title: '📰 25.18 패치노트',
      url: 'https://example.invalid/patch-25-18',
      color: 0x1a78ae,
      footer: { text: 'offline test' },
      fields: [{ name: '📋 패치 요약', value: '정상 요약' }],
    },
    startupLastUrls: { lol: 'https://example.invalid/lol/previous' },
  });

  await harness.scheduler.startUnifiedPatchScheduler(harness.client);

  assert.equal(harness.sent.length, 3);
  assert.deepEqual(harness.startupSaves, []);

  harness.scheduler.stopUnifiedPatchScheduler();
});

test('동일한 URL은 새 패치로 반환하지 않고 상세 페이지와 DB 저장을 건너뛴다', async () => {
  const url = 'https://www.leagueoflegends.com/ko-kr/news/game-updates/patch-25-18-notes/';
  const { crawler, calls } = createLolCrawlerFixture({ lastUrl: url, latestUrl: url });

  const result = await crawler.checkForNewPatch();

  assert.equal(result, null);
  assert.equal(calls.detail, 0);
  assert.equal(calls.insert, 0);
});

test('crawler parser는 article에서 제목과 본문을 추출해 patchData로 만든다', async () => {
  const url = 'https://www.leagueoflegends.com/ko-kr/news/game-updates/patch-25-18-notes/';
  const { crawler, calls } = createLolCrawlerFixture({ latestUrl: url });

  const patchData = await crawler.crawlPatchContent(url);

  assert.equal(patchData.title, '25.18 패치노트');
  assert.equal(patchData.url, url);
  assert.match(patchData.content, /챔피언 1의 능력치가 조정되었습니다/);
  assert.doesNotMatch(patchData.content, /<article>|<p>/);
  assert.equal(calls.detail, 1);
});

test('현재 결함 재현: DB 상태 저장 실패 시 같은 패치가 연속 두 번 게시 대상으로 반환된다', async () => {
  const { crawler, calls } = createLolCrawlerFixture({
    lastUrl: 'https://www.leagueoflegends.com/old-patch/',
    saveError: new Error('offline test DB failure'),
  });

  const first = await crawler.checkForNewPatch();
  const second = await crawler.checkForNewPatch();

  assert.ok(first, '첫 번째 실행에서 새 패치가 반환되어야 재현 조건이 성립한다.');
  assert.ok(second, '저장 실패가 전파되지 않아 두 번째 실행에서도 같은 패치가 반환된다.');
  assert.equal(first.url, second.url);
  assert.equal(calls.insert, 2);
});

test('현재 결함 재현: 동시에 실행된 두 checker가 같은 패치를 모두 게시 대상으로 반환한다', async () => {
  const { crawler, calls } = createLolCrawlerFixture({
    lastUrl: 'https://www.leagueoflegends.com/old-patch/',
    beforeSelectReturn: createBarrier(2),
  });

  const results = await Promise.all([
    crawler.checkForNewPatch(),
    crawler.checkForNewPatch(),
  ]);

  assert.equal(results.filter(Boolean).length, 2);
  assert.equal(results[0].url, results[1].url);
  assert.equal(calls.insert, 2);
});

test('현재 결함 재현: trailing slash만 달라도 이미 처리한 URL을 새 패치로 판단한다', async () => {
  const canonical = 'https://www.leagueoflegends.com/ko-kr/news/game-updates/patch-25-18-notes';
  const { crawler, calls } = createLolCrawlerFixture({
    lastUrl: canonical,
    latestUrl: `${canonical}/`,
  });

  const result = await crawler.checkForNewPatch();

  assert.ok(result);
  assert.equal(calls.detail, 1);
  assert.equal(calls.insert, 1);
});

test('AI key가 없으면 LoL/TFT/Valorant 모두 원문 대신 명시적 실패 요약을 만든다', async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const ai = loadAiSummarizerWithoutApiKey();
    const rawMarker = 'RAW_PATCH_CONTENT_MUST_NOT_BE_POSTED';
    const patchData = {
      title: '오프라인 테스트 패치',
      url: 'https://example.invalid/patch',
      content: `${rawMarker}\n${'원문 변경사항 '.repeat(300)}`,
    };
    const summarizeFunctions = [
      ai.summarizePatchNotes,
      ai.summarizeTftPatchNotes,
      ai.summarizeValorantPatchNotes,
    ];

    for (const summarize of summarizeFunctions) {
      const summary = await summarize(patchData);
      assert.ok(summary.startsWith(ai.SUMMARY_FAILED_MARKER));
      assert.doesNotMatch(summary, new RegExp(rawMarker));
      assert.match(summary, /원문 보기/);
    }
  } finally {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

test('정상 요약은 게임별 formatter에서 section field 레이아웃으로 변환된다', () => {
  const ai = loadAiSummarizerWithoutApiKey();
  const summary = [
    '## 📋 패치 요약',
    '핵심 변경 한 줄',
    '두 번째 핵심 변경',
    '',
    '## 🔺 버프 (상향)',
    '- 아리: Q 피해량 70 → 80',
  ].join('\n');
  const patchData = { title: '25.18', url: 'https://example.invalid/patch' };
  const formatters = [
    ai.formatForDiscord,
    ai.formatTftForDiscord,
    ai.formatValorantForDiscord,
  ];

  for (const format of formatters) {
    const result = format(summary, patchData);
    assert.equal(result.fields.length, 2);
    assert.equal(result.fields[0].name, '📋 패치 요약');
    assert.equal(result.fields[0].value, '핵심 변경 한 줄\n두 번째 핵심 변경');
    assert.equal(result.fields[1].name, '🔺 버프 (상향)');
    assert.match(result.fields[1].value, /아리/);
  }
});

test('긴 section은 내용 손실 없이 여러 field로 나뉜다', () => {
  const ai = loadAiSummarizerWithoutApiKey();
  const summary = `## 📋 패치 요약\n${'가'.repeat(1500)}`;
  const patchData = { title: '25.18', url: 'https://example.invalid/patch' };

  for (const format of [
    ai.formatForDiscord,
    ai.formatTftForDiscord,
    ai.formatValorantForDiscord,
  ]) {
    const fields = format(summary, patchData).fields;
    assert.equal(fields.length, 2);
    assert.ok(fields.every(field => field.value.length <= 1024));
    assert.equal(fields.map(field => field.value).join(''), '가'.repeat(1500));
  }
});

test('AI가 header 없이 응답해도 요약 본문을 보존한다', () => {
  const ai = loadAiSummarizerWithoutApiKey();
  const rawResponse = '이번 패치에서는 여러 챔피언과 아이템이 조정되었습니다.';
  const patchData = { title: '25.18', url: 'https://example.invalid/patch' };

  for (const format of [
    ai.formatForDiscord,
    ai.formatTftForDiscord,
    ai.formatValorantForDiscord,
  ]) {
    const result = format(rawResponse, patchData);
    assert.equal(result.fields[0].name, '📋 패치 요약');
    assert.equal(result.fields[0].value, rawResponse);
  }
});

test('현재 결함 재현: AI가 원문을 section에 넣으면 1~2줄 요약 규칙 없이 그대로 통과한다', () => {
  const ai = loadAiSummarizerWithoutApiKey();
  const rawLines = Array.from(
    { length: 12 },
    (_, index) => `원문 세부 변경 ${index + 1}: 수치와 설명이 그대로 포함됩니다.`
  );
  const summary = `## 📋 패치 요약\n${rawLines.join('\n')}`;
  const patchData = { title: '25.18', url: 'https://example.invalid/patch' };

  for (const format of [
    ai.formatForDiscord,
    ai.formatTftForDiscord,
    ai.formatValorantForDiscord,
  ]) {
    const field = format(summary, patchData).fields[0];
    assert.equal(field.value.split('\n').length, 12);
    assert.match(field.value, /원문 세부 변경 12/);
  }
});

test('scheduler는 AI 실패 시 성공 문구 대신 실패 alert, 실패 field, 원문 링크를 순서대로 보낸다', async () => {
  const summary = [
    '## ⚠️ AI 요약 실패',
    '',
    'AI 요약을 생성하지 못했습니다. 아래 **원문 보기** 링크를 확인해주세요.',
    '사유: `offline test`',
  ].join('\n');
  const ai = loadAiSummarizerWithoutApiKey();
  const patchData = {
    title: '25.18 패치노트',
    url: 'https://example.invalid/patch-25-18',
  };
  const harness = createSchedulerHarness({
    summary,
    embedData: ai.formatForDiscord(summary, patchData),
  });

  await harness.scheduler.startUnifiedPatchScheduler(harness.client);
  assert.equal(harness.sent.length, 0, '초기 동기화 단계에서는 알림을 보내면 안 된다.');

  const callback = harness.getScheduledCallback();
  assert.equal(typeof callback, 'function');
  await callback();

  assert.equal(harness.sent.length, 3);
  const alert = harness.sent[0].embeds[0].data;
  const patch = harness.sent[1].embeds[0].data;
  assert.match(alert.description, /AI 요약에 실패/);
  assert.doesNotMatch(alert.description, /분석하고 요약했습니다/);
  assert.equal(patch.fields[0].name, '⚠️ AI 요약 실패');
  assert.doesNotMatch(patch.fields[0].value, /RAW_SCHEDULER_PATCH_CONTENT/);
  assert.equal(harness.sent[2], `📎 **원문 보기:** ${harness.patchData.url}`);

  harness.scheduler.stopUnifiedPatchScheduler();
});

test('scheduler는 Discord 한도에 맞춰 26개 field를 25개와 1개 embed로 나눈다', async () => {
  const fields = Array.from({ length: 26 }, (_, index) => ({
    name: `section-${index + 1}`,
    value: `summary-${index + 1}`,
  }));
  const harness = createSchedulerHarness({
    summary: '## 📋 패치 요약\n정상 요약',
    embedData: {
      title: '📰 25.18 패치노트',
      url: 'https://example.invalid/patch-25-18',
      color: 0x1a78ae,
      footer: { text: 'offline test' },
      fields,
    },
  });

  await harness.scheduler.startUnifiedPatchScheduler(harness.client);
  await harness.getScheduledCallback()();

  assert.equal(harness.sent.length, 4);
  assert.equal(harness.sent[0].embeds[0].data.fields.length, 0);
  assert.equal(harness.sent[1].embeds[0].data.fields.length, 25);
  assert.equal(harness.sent[2].embeds[0].data.fields.length, 1);
  assert.equal(harness.sent[3], `📎 **원문 보기:** ${harness.patchData.url}`);

  harness.scheduler.stopUnifiedPatchScheduler();
});

test('scheduler는 같은 patch를 다시 발견해도 배달 기록을 통해 한 번만 게시한다', async () => {
  const fields = [{ name: '📋 패치 요약', value: '정상 요약' }];
  const harness = createSchedulerHarness({
    summary: '## 📋 패치 요약\n정상 요약',
    embedData: {
      title: '📰 25.18 패치노트',
      url: 'https://example.invalid/patch-25-18',
      color: 0x1a78ae,
      footer: { text: 'offline test' },
      fields,
    },
  });

  await harness.scheduler.startUnifiedPatchScheduler(harness.client);
  const callback = harness.getScheduledCallback();
  await callback();
  await callback();

  const originalLinks = harness.sent.filter(
    (payload) => payload === `📎 **원문 보기:** ${harness.patchData.url}`
  );
  assert.equal(harness.sent.length, 3);
  assert.equal(originalLinks.length, 1);

  harness.scheduler.stopUnifiedPatchScheduler();
});
