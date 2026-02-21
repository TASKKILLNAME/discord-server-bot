// ============================================
// 🖼️ Report Renderer — Puppeteer 이미지 렌더링
// HTML 템플릿 → 1080x1080 PNG
// ============================================

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

let browserInstance = null;

/**
 * 공유 브라우저 인스턴스 (재사용으로 성능 향상)
 */
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    };

    // Docker 환경에서 시스템 Chromium 사용
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browserInstance = await puppeteer.launch(launchOptions);
  }
  return browserInstance;
}

/**
 * 분석 리포트를 1080x1080 PNG로 렌더링
 *
 * @param {Object} decisionData - matchParser 출력
 * @param {string} coachFeedback - coachAnalyzer 출력 (마크다운)
 * @param {Object} playerInfo - { gameName, tagLine, rank, champion, win }
 * @returns {Buffer} PNG 이미지 버퍼
 */
async function renderAnalysisReport(decisionData, coachFeedback, playerInfo) {
  const templatePath = path.join(__dirname, '../templates/analysisReport.html');
  let html = fs.readFileSync(templatePath, 'utf-8');

  // 데이터 치환
  const kda = `${decisionData.playerInfo.kills}/${decisionData.playerInfo.deaths}/${decisionData.playerInfo.assists}`;
  const kdaRatio = decisionData.playerInfo.deaths === 0
    ? 'Perfect'
    : ((decisionData.playerInfo.kills + decisionData.playerInfo.assists) / decisionData.playerInfo.deaths).toFixed(2);

  html = html
    .replace(/\{\{PLAYER_NAME\}\}/g, escapeHtml(`${playerInfo.gameName}#${playerInfo.tagLine}`))
    .replace(/\{\{RANK\}\}/g, escapeHtml(playerInfo.rank))
    .replace(/\{\{CHAMPION\}\}/g, escapeHtml(decisionData.playerInfo.champion))
    .replace(/\{\{ROLE\}\}/g, escapeHtml(translateRole(decisionData.playerInfo.role)))
    .replace(/\{\{RESULT\}\}/g, decisionData.playerInfo.win ? '승리' : '패배')
    .replace(/\{\{RESULT_COLOR\}\}/g, decisionData.playerInfo.win ? '#57f287' : '#ed4245')
    .replace(/\{\{KDA\}\}/g, kda)
    .replace(/\{\{KDA_RATIO\}\}/g, kdaRatio)
    .replace(/\{\{GAME_DURATION\}\}/g, `${Math.floor(decisionData.gameDuration / 60)}분`)
    .replace(/\{\{DEATHS_COUNT\}\}/g, String(decisionData.deathAnalysis.length))
    .replace(/\{\{OBJ_PARTICIPATION\}\}/g, `${decisionData.objectiveParticipation.participationRate}%`)
    .replace(/\{\{GOLD_DIFF_10\}\}/g, formatGoldDiff(decisionData.goldEfficiency.goldDiffAt10))
    .replace(/\{\{GOLD_DIFF_15\}\}/g, formatGoldDiff(decisionData.goldEfficiency.goldDiffAt15))
    .replace(/\{\{CS_AT_10\}\}/g, String(decisionData.goldEfficiency.csAt10))
    .replace(/\{\{CS_AT_15\}\}/g, String(decisionData.goldEfficiency.csAt15))
    .replace(/\{\{VISION_TOTAL\}\}/g, String(decisionData.visionTimeline.wardsPlacedTotal))
    .replace(/\{\{VISION_EARLY\}\}/g, String(decisionData.visionTimeline.earlyWardsPlaced))
    .replace(/\{\{VISION_LATE\}\}/g, String(decisionData.visionTimeline.lateWardsPlaced))
    .replace(/\{\{KILL_PARTICIPATION\}\}/g, `${decisionData.combatProfile.killParticipation}%`)
    .replace(/\{\{SOLO_KILLS\}\}/g, String(decisionData.combatProfile.soloKills))
    .replace(/\{\{DAMAGE_DEALT\}\}/g, decisionData.combatProfile.damageDealt.toLocaleString())
    .replace(/\{\{DEATH_TABLE_ROWS\}\}/g, renderDeathTableRows(decisionData.deathAnalysis))
    .replace(/\{\{COACH_FEEDBACK\}\}/g, formatCoachFeedbackForHtml(coachFeedback));

  const browser = await getBrowser();
  const page = await browser.newPage();

  await page.setViewport({ width: 1080, height: 1080 });
  await page.setContent(html, { waitUntil: 'load', timeout: 10000 });

  // 콘텐츠 높이에 따라 동적 조정 (최소 1080px)
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  const finalHeight = Math.max(1080, bodyHeight);

  if (finalHeight > 1080) {
    await page.setViewport({ width: 1080, height: finalHeight });
  }

  const screenshot = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: 1080, height: finalHeight },
  });

  await page.close();
  return screenshot;
}

// ============================================
// 📝 헬퍼 함수
// ============================================
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatGoldDiff(diff) {
  if (diff > 0) return `<span class="gold-positive">+${diff}</span>`;
  if (diff < 0) return `<span class="gold-negative">${diff}</span>`;
  return `<span class="gold-neutral">0</span>`;
}

function renderDeathTableRows(deaths) {
  if (deaths.length === 0) {
    return '<tr><td colspan="4" style="text-align:center;color:#99aab5;">사망 기록 없음 (Perfect Game!)</td></tr>';
  }

  return deaths
    .map(
      (d) =>
        `<tr>
      <td>${d.minuteMark.toFixed(1)}분</td>
      <td>${translateLocationType(d.locationType)}</td>
      <td>${formatGoldDiff(d.goldDiffBeforeDeath)}</td>
      <td>${translateDeathContext(d.deathContext)}</td>
    </tr>`
    )
    .join('');
}

function translateLocationType(type) {
  const map = {
    LANE_SAFE: '라인 (안전)',
    LANE_OVEREXTENDED: '과확장',
    RIVER: '리버',
    ENEMY_JUNGLE: '적 정글',
    OWN_JUNGLE: '아군 정글',
    ENEMY_BASE: '적 베이스',
    UNKNOWN: '-',
  };
  return map[type] || type;
}

function translateDeathContext(ctx) {
  const map = {
    SOLO_DEATH: '솔로 데스',
    TEAMFIGHT_DEATH: '팀파이트',
    GANK_DEATH: '갱킹',
    DIVE_DEATH: '다이브',
  };
  return map[ctx] || ctx;
}

function translateRole(role) {
  const map = {
    TOP: '탑', JUNGLE: '정글', MIDDLE: '미드',
    BOTTOM: '원딜', UTILITY: '서포터', UNKNOWN: '',
  };
  return map[role] || role;
}

function formatCoachFeedbackForHtml(markdown) {
  return markdown
    .replace(/## (.*)/g, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.*)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
    .replace(/\n/g, '<br>');
}

/**
 * 프로세스 종료 시 브라우저 정리
 */
async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

module.exports = { renderAnalysisReport, closeBrowser };
