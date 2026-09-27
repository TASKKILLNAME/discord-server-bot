'use strict';

// Characterization tests for patch-note deduplication.
// A test prefixed with [KNOWN DEFECT] passes when it reproduces the unsafe
// behavior that currently exists. These tests never call Riot, Discord, or a
// real PostgreSQL server.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const FIXTURES = [
  {
    game: 'lol',
    modulePath: 'src/services/patchCrawler.js',
    listUrl: 'https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/',
    patchUrl: 'https://www.leagueoflegends.com/ko-kr/news/game-updates/patch-26-17-notes/',
    listHtml:
      '<a href="/ko-kr/news/game-updates/patch-26-17-notes/"><h2>26.17 패치 노트</h2></a>',
  },
  {
    game: 'valorant',
    modulePath: 'src/services/valorantCrawler.js',
    listUrl: 'https://playvalorant.com/ko-kr/news/game-updates/',
    patchUrl: 'https://playvalorant.com/ko-kr/news/game-updates/valorant-patch-notes-11-08/',
    listHtml:
      '<a href="/ko-kr/news/game-updates/valorant-patch-notes-11-08/"><h2>발로란트 11.08 패치 노트</h2></a>',
  },
  {
    game: 'tft',
    modulePath: 'src/services/tftCrawler.js',
    listUrl: 'https://teamfighttactics.leagueoflegends.com/ko-kr/news/',
    patchUrl:
      'https://teamfighttactics.leagueoflegends.com/ko-kr/news/game-updates/teamfight-tactics-patch-15-17-notes/',
    listHtml:
      '<a href="/ko-kr/news/game-updates/teamfight-tactics-patch-15-17-notes/"><h2>TFT 15.17 패치 노트</h2></a>',
  },
];

function loadCommonJsWithMocks(relativePath, mocks) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const loadedModule = { exports: {} };
  const realRequire = Module.createRequire(filename);
  const mockedRequire = (request) =>
    Object.prototype.hasOwnProperty.call(mocks, request) ? mocks[request] : realRequire(request);

  const compiledWrapper = new vm.Script(Module.wrap(source), { filename }).runInThisContext();
  compiledWrapper.call(
    loadedModule.exports,
    loadedModule.exports,
    mockedRequire,
    loadedModule,
    filename,
    path.dirname(filename)
  );
  return loadedModule.exports;
}

function createAxios(fixture) {
  const calls = [];
  const articleText = '중요 밸런스 변경 사항과 수치 조정 내용입니다. '.repeat(20);
  return {
    calls,
    module: {
      async get(url) {
        calls.push(url);
        if (url === fixture.listUrl) return { data: fixture.listHtml };
        if (url === fixture.patchUrl) {
          return {
            data: `<html><body><h1>${fixture.game} 최신 패치</h1><article>${articleText}</article></body></html>`,
          };
        }
        throw new Error(`Unexpected HTTP request in test: ${url}`);
      },
    },
  };
}

function createPool({
  game,
  initialUrl = null,
  failReads = false,
  failWrites = false,
  readBarrier = 0,
}) {
  let state = initialUrl
    ? { last_url: initialUrl, last_title: `${game} 이전 저장값` }
    : null;
  const stats = { selects: 0, writes: 0 };
  const waitingReads = [];

  return {
    stats,
    get state() {
      return state;
    },
    module: {
      async query(sql, values) {
        if (/^\s*SELECT\b/i.test(sql)) {
          stats.selects += 1;
          const snapshot = state ? { ...state } : null;
          if (failReads) throw new Error('simulated database read failure');

          if (readBarrier > 0 && stats.selects <= readBarrier) {
            await new Promise((resolve) => {
              waitingReads.push(resolve);
              if (waitingReads.length === readBarrier) {
                for (const release of waitingReads.splice(0)) release();
              }
            });
          }

          return { rows: snapshot ? [snapshot] : [] };
        }

        if (/^\s*INSERT\b/i.test(sql)) {
          stats.writes += 1;
          if (failWrites) throw new Error('simulated database write failure');
          state = { last_url: values[1], last_title: values[2] };
          return { rows: [] };
        }

        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
  };
}

function loadCrawler(fixture, pool, axios) {
  return loadCommonJsWithMocks(fixture.modulePath, {
    '../db': { pool: pool.module },
    axios: axios.module,
  });
}

function silenceExpectedLogs(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
}

for (const fixture of FIXTURES) {
  test(`${fixture.game}: 저장된 URL과 정확히 같으면 자동 게시 후보를 만들지 않는다`, async (t) => {
    silenceExpectedLogs(t);
    const axios = createAxios(fixture);
    const pool = createPool({ game: fixture.game, initialUrl: fixture.patchUrl });
    const crawler = loadCrawler(fixture, pool, axios);

    const result = await crawler.checkForNewPatch();

    assert.equal(result, null);
    assert.deepEqual(axios.calls, [fixture.listUrl]);
    assert.deepEqual(pool.stats, { selects: 1, writes: 0 });
  });

  test(`[KNOWN DEFECT] ${fixture.game}: 상태 저장 실패 후 같은 패치를 연속 두 번 게시 후보로 반환한다`, async (t) => {
    silenceExpectedLogs(t);
    const axios = createAxios(fixture);
    const pool = createPool({
      game: fixture.game,
      initialUrl: `${fixture.patchUrl}previous/`,
      failWrites: true,
    });
    const crawler = loadCrawler(fixture, pool, axios);

    const first = await crawler.checkForNewPatch();
    const second = await crawler.checkForNewPatch();

    assert.equal(first.url, fixture.patchUrl);
    assert.equal(second.url, fixture.patchUrl);
    assert.equal(pool.stats.writes, 2);
    assert.equal(
      axios.calls.filter((url) => url === fixture.patchUrl).length,
      2,
      '같은 상세 패치 페이지를 두 번 크롤링했다'
    );
  });

  test(`[KNOWN DEFECT] ${fixture.game}: 상태 조회 실패를 미게시 상태로 간주해 이미 저장된 패치를 반환한다`, async (t) => {
    silenceExpectedLogs(t);
    const axios = createAxios(fixture);
    const pool = createPool({
      game: fixture.game,
      initialUrl: fixture.patchUrl,
      failReads: true,
    });
    const crawler = loadCrawler(fixture, pool, axios);

    const result = await crawler.checkForNewPatch();

    assert.equal(result.url, fixture.patchUrl);
    assert.deepEqual(pool.stats, { selects: 1, writes: 1 });
  });

  test(`[KNOWN DEFECT] ${fixture.game}: 동시에 실행된 두 체크가 같은 새 패치를 모두 게시 후보로 반환한다`, async (t) => {
    silenceExpectedLogs(t);
    const axios = createAxios(fixture);
    const pool = createPool({
      game: fixture.game,
      initialUrl: `${fixture.patchUrl}previous/`,
      readBarrier: 2,
    });
    const crawler = loadCrawler(fixture, pool, axios);

    const results = await Promise.all([
      crawler.checkForNewPatch(),
      crawler.checkForNewPatch(),
    ]);

    assert.equal(results.filter(Boolean).length, 2);
    assert.equal(pool.stats.selects, 2);
    assert.equal(pool.stats.writes, 2);
  });

  test(`[KNOWN DEFECT] ${fixture.game}: 같은 문서의 trailing-slash URL 차이를 새 패치로 판단한다`, async (t) => {
    silenceExpectedLogs(t);
    const axios = createAxios(fixture);
    const pool = createPool({
      game: fixture.game,
      initialUrl: fixture.patchUrl.replace(/\/$/, ''),
    });
    const crawler = loadCrawler(fixture, pool, axios);

    const result = await crawler.checkForNewPatch();

    assert.equal(result.url, fixture.patchUrl);
    assert.equal(pool.stats.writes, 1);
  });

  test(`[KNOWN DEFECT] ${fixture.game}: 강제 최신 조회는 이미 저장된 패치도 매번 반환한다`, async (t) => {
    silenceExpectedLogs(t);
    const axios = createAxios(fixture);
    const pool = createPool({ game: fixture.game, initialUrl: fixture.patchUrl });
    const crawler = loadCrawler(fixture, pool, axios);

    const first = await crawler.forceGetLatestPatch();
    const second = await crawler.forceGetLatestPatch();

    assert.equal(first.url, fixture.patchUrl);
    assert.equal(second.url, fixture.patchUrl);
    assert.equal(pool.stats.selects, 0, '강제 조회 경로에는 중복 확인 SELECT가 없다');
    assert.equal(pool.stats.writes, 2);
  });
}
