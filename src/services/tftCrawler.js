const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/lastTftPatch.json');

function loadLastPatch() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('TFT 패치 데이터 로드 실패:', err.message);
  }
  return { lastUrl: null, lastTitle: null };
}

function saveLastPatch(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('TFT 패치 데이터 저장 실패:', err.message);
  }
}

async function getLatestPatchUrl() {
  try {
    const listUrl = 'https://teamfighttactics.leagueoflegends.com/ko-kr/news/';
    const { data: html } = await axios.get(listUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(html);

    let latestUrl = null;
    let latestTitle = null;

    // TFT 패치노트 링크 탐색
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (
        (href.includes('patch-') || href.includes('teamfight-tactics-patch')) &&
        !latestUrl
      ) {
        latestUrl = href.startsWith('http')
          ? href
          : `https://teamfighttactics.leagueoflegends.com${href}`;
        latestTitle = $(el).find('h2').text().trim() || $(el).text().trim();
      }
    });

    // 대체: LoL 사이트 TFT 태그 페이지
    if (!latestUrl) {
      const fallbackUrl = 'https://www.leagueoflegends.com/ko-kr/news/tags/tft/';
      const { data: fallbackHtml } = await axios.get(fallbackUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
        timeout: 15000,
      });

      const $2 = cheerio.load(fallbackHtml);
      $2('a').each((i, el) => {
        const href = $2(el).attr('href') || '';
        if (href.match(/patch-\d+/i) && !latestUrl) {
          latestUrl = href.startsWith('http')
            ? href
            : `https://www.leagueoflegends.com${href}`;
          latestTitle = $2(el).text().trim();
        }
      });
    }

    return { url: latestUrl, title: latestTitle };
  } catch (err) {
    console.error('TFT 패치노트 목록 가져오기 실패:', err.message);
    return { url: null, title: null };
  }
}

async function crawlPatchContent(url) {
  try {
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 20000,
    });

    const $ = cheerio.load(html);

    let content = '';
    let title = '';

    title =
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      'TFT 패치노트';

    const selectors = [
      '.style__Wrapper-sc-1wye7eo-0',
      '.article-content',
      '[data-testid="article-content"]',
      'article',
      '.patch-notes-container',
      'main',
    ];

    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0) {
        content = el.text().trim();
        if (content.length > 200) break;
      }
    }

    if (content.length < 200) {
      $('script, style, nav, footer, header').remove();
      content = $('body').text().trim();
    }

    if (content.length > 15000) {
      content = content.substring(0, 15000) + '\n\n... (이하 생략)';
    }

    return { title, content, url };
  } catch (err) {
    console.error('TFT 패치노트 크롤링 실패:', err.message);
    return null;
  }
}

async function checkForNewPatch() {
  const lastPatch = loadLastPatch();
  const latest = await getLatestPatchUrl();

  if (!latest.url) {
    console.log('⚠️ TFT 최신 패치노트 URL을 가져올 수 없습니다.');
    return null;
  }

  if (latest.url === lastPatch.lastUrl) {
    console.log(`📋 TFT 새 패치 없음 (현재: ${lastPatch.lastTitle || latest.url})`);
    return null;
  }

  console.log(`🆕 TFT 새 패치노트 발견! ${latest.title || latest.url}`);

  const patchData = await crawlPatchContent(latest.url);

  if (patchData) {
    saveLastPatch({
      lastUrl: latest.url,
      lastTitle: latest.title || patchData.title,
      checkedAt: new Date().toISOString(),
    });
  }

  return patchData;
}

async function forceGetLatestPatch() {
  const latest = await getLatestPatchUrl();

  if (!latest.url) {
    return null;
  }

  const patchData = await crawlPatchContent(latest.url);

  if (patchData) {
    saveLastPatch({
      lastUrl: latest.url,
      lastTitle: latest.title || patchData.title,
      checkedAt: new Date().toISOString(),
    });
  }

  return patchData;
}

module.exports = {
  checkForNewPatch,
  forceGetLatestPatch,
  getLatestPatchUrl,
  crawlPatchContent,
  loadLastPatch,
  saveLastPatch,
};
