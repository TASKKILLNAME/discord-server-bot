'use strict';

// 크레딧·멤버십 기능 제거 회귀 테스트. 실제 Riot API·Discord·DB 없이 실행한다.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadWithMocks } = require('./helpers/load-with-mocks');

const ROOT = path.resolve(__dirname, '..');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.(js|html)$/.test(entry.name) ? [target] : [];
  });
}

test('소스·대시보드에 크레딧/멤버십 코드와 /멤버십 명령이 남아 있지 않다', () => {
  const pattern = /membershipService|hasCredit|useCredit|getCredits|chargeCredits|membership_|\/api\/membership|크레딧|멤버십/;
  const offenders = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'dashboard'))]
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(offenders, []);

  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'commands', 'membership.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'services', 'membershipService.js')), false);
});

function loadLol(calls) {
  return loadWithMocks(path.join(ROOT, 'src', 'commands', 'lol.js'), {
    '../services/riotService': {
      fetchLiveGameData: async () => ({ notInGame: false, blueTeam: [], redTeam: [] }),
      fetchRecentMatchData: async () => ({ matches: [{ champion: 'Ahri' }] }),
    },
    '../services/lolAnalyzer': {
      analyzeLiveGame: async () => {
        calls.push('analyzeLiveGame');
        return '## 분석';
      },
      analyzeRecentMatches: async () => {
        calls.push('analyzeRecentMatches');
        return '## 분석';
      },
      parseAnalysisToFields: () => [{ name: '분석', value: '정상' }],
    },
    '../services/lolTrackerService': {},
    // /전적 실시간은 게임 시작 브리핑으로 바뀌었다. 게임 중이 아니면 기존 최근 1게임 AI 분석으로 대체한다.
    '../services/liveBriefingService': {
      BriefingError: class BriefingError extends Error {},
      createLiveBriefing: async () => ({ notInGame: true, account: { gameName: 'Tester', tagLine: 'KR1' } }),
      tryAcquireCooldown: () => 0,
      describeErrorForLog: (err) => err.message,
    },
    '../services/matchLayoutService': {
      buildRecentMatchLayout: () => ({ components: [{ type: 'recent' }], flags: 32768 }),
      buildLiveGameLayout: () => ({ components: [{ type: 'live' }], flags: 32768 }),
      buildSingleMatchLayout: () => ({ components: [{ type: 'single' }], flags: 32768 }),
    },
  });
}

test('/전적 실시간·최근전적은 크레딧 확인 없이 AI 분석 결과를 응답한다', async () => {
  for (const [subcommand, analyzer, component] of [
    ['최근전적', 'analyzeRecentMatches', 'recent'],
    ['실시간', 'analyzeRecentMatches', 'single'],
  ]) {
    const calls = [];
    const command = loadLol(calls);
    const log = [];
    await command.execute({
      guild: { id: 'g1' },
      user: { id: 'u1' },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => (name === '소환사명' ? 'Tester' : 'KR1'),
        getInteger: () => null,
      },
      async deferReply() { log.push('defer'); },
      async reply(value) { log.push(['reply', value]); },
      async editReply(value) { log.push(['edit', value]); },
    });

    assert.deepEqual(calls, [analyzer], subcommand);
    assert.equal(log[0], 'defer', subcommand);
    assert.ok(!log.some((entry) => entry[0] === 'reply'), `${subcommand}: 거절 응답 없음`);
    const last = log.at(-1)[1];
    assert.equal(last.components[0].type, component, subcommand);
    for (const [, value] of log.slice(1)) {
      assert.doesNotMatch(JSON.stringify(value), /크레딧/, subcommand);
    }
  }
});
