// ============================================
// 🖼️ Image Service — Puppeteer 리포트 이미지 생성
// ============================================

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  return browserInstance;
}

async function generateReportImage(analysisText, matchInfo) {
  const templatePath = path.join(__dirname, '..', 'templates', 'report.html');
  const template = fs.readFileSync(templatePath, 'utf-8');

  // KDA 문자열 생성
  const kdaStr = matchInfo.raw
    ? matchInfo.raw.kda.toFixed(2)
    : `${matchInfo.kills || 0}/${matchInfo.deaths || 0}/${matchInfo.assists || 0}`;

  // CS 문자열 생성
  const csStr = matchInfo.raw ? matchInfo.raw.cs_per_min.toFixed(1) + '/분' : '-';

  // 결과 색상
  const resultColor = matchInfo.team_result === 'WIN' ? '#2ecc71' : '#e74c3c';

  // 템플릿 변수 치환
  const html = template
    .replace(/\{\{SUMMONER\}\}/g, escapeHtml(matchInfo.summoner || ''))
    .replace(/\{\{CHAMPION\}\}/g, escapeHtml(matchInfo.champion || ''))
    .replace(/\{\{TIER\}\}/g, escapeHtml((matchInfo.tier || '').toUpperCase()))
    .replace(/\{\{RESULT\}\}/g, matchInfo.team_result || '')
    .replace(/\{\{RESULT_COLOR\}\}/g, resultColor)
    .replace(/\{\{KDA\}\}/g, escapeHtml(kdaStr))
    .replace(/\{\{CS\}\}/g, escapeHtml(csStr))
    .replace(/\{\{ANALYSIS\}\}/g, formatAnalysisHtml(analysisText))
    .replace(/\{\{PATCH\}\}/g, escapeHtml(matchInfo.patch || ''));

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1080, height: 1080 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // 콘텐츠 높이에 맞게 조정
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    if (bodyHeight > 1080) {
      await page.setViewport({ width: 1080, height: Math.min(bodyHeight, 2000) });
    }

    const outputPath = path.join(
      process.env.TEMP || '/tmp',
      `report_${Date.now()}.png`,
    );
    await page.screenshot({ path: outputPath, fullPage: false });

    return outputPath;
  } finally {
    await page.close();
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAnalysisHtml(text) {
  return text
    .replace(/\*\*\[(.+?)\]\*\*/g, '<div class="section-header">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

module.exports = { generateReportImage };
