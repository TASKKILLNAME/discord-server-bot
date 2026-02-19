const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/lastPatch.json');

/**
 * 마지막으로 확인한 패치 정보 로드
 */
function loadLastPatch() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('패치 데이터 로드 실패:', err.message);
  }
  return { lastUrl: null, lastTitle: null };
}

/**
 * 마지막 패치 정보 저장
 */
function saveLastPatch(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('패치 데이터 저장 실패:', err.message);
  }
}

/**
 * 라이엇 패치노트 목록 페이지에서 최신 패치노트 URL 가져오기
 */
async function getLatestPatchUrl() {
  try {
    // 라이엇 한국 패치노트 페이지
    const listUrl = 'https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/';
    const { data: html } = await axios.get(listUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(html);

    // 최신 패치노트 링크 찾기
    let latestUrl = null;
    let latestTitle = null;

    // 패치노트 카드/링크 찾기
    $('a[href*="patch-"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('patch-') && !latestUrl) {
        latestUrl = href.startsWith('http')
          ? href
          : `https://www.leagueoflegends.com${href}`;
        latestTitle = $(el).find('h2').text().trim() || $(el).text().trim();
      }
    });

    // 대체: 메타데이터에서 찾기
    if (!latestUrl) {
      $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        if (href.match(/patch-\d+-\d+/i) && !latestUrl) {
          latestUrl = href.startsWith('http')
            ? href
            : `https://www.leagueoflegends.com${href}`;
          latestTitle = $(el).text().trim();
        }
      });
    }

    return { url: latestUrl, title: latestTitle };
  } catch (err) {
    console.error('패치노트 목록 가져오기 실패:', err.message);
    return { url: null, title: null };
  }
}

/**
 * 패치노트 상세 내용 크롤링
 */
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

    // 패치노트 본문 추출
    let content = '';
    let title = '';

    // 제목 추출
    title =
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      '롤 패치노트';

    // 본문 내용 추출 - 여러 셀렉터 시도
    const selectors = [
      '.style__Wrapper-sc-1wye7eo-0',
      '.article-content',
      '[data-testid="article-content"]',
      '.style__ArticleContent',
      'article',
      '.patch-notes-container',
      '#patch-notes-container',
      'main',
    ];

    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0) {
        content = el.text().trim();
        if (content.length > 200) break;
      }
    }

    // 그래도 없으면 body에서 추출
    if (content.length < 200) {
      // 스크립트/스타일 제거 후 body 텍스트
      $('script, style, nav, footer, header').remove();
      content = $('body').text().trim();
    }

    // 너무 긴 내용은 잘라내기 (Claude API 토큰 절약)
    if (content.length > 15000) {
      content = content.substring(0, 15000) + '\n\n... (이하 생략)';
    }

    return { title, content, url };
  } catch (err) {
    console.error('패치노트 크롤링 실패:', err.message);
    return null;
  }
}

/**
 * 새 패치노트가 있는지 확인
 */
async function checkForNewPatch() {
  const lastPatch = loadLastPatch();
  const latest = await getLatestPatchUrl();

  if (!latest.url) {
    console.log('⚠️ 최신 패치노트 URL을 가져올 수 없습니다.');
    return null;
  }

  // 같은 패치면 스킵
  if (latest.url === lastPatch.lastUrl) {
    console.log(`📋 새 패치 없음 (현재: ${lastPatch.lastTitle || latest.url})`);
    return null;
  }

  console.log(`🆕 새 패치노트 발견! ${latest.title || latest.url}`);

  // 상세 내용 크롤링
  const patchData = await crawlPatchContent(latest.url);

  if (patchData) {
    // 마지막 패치 정보 저장
    saveLastPatch({
      lastUrl: latest.url,
      lastTitle: latest.title || patchData.title,
      checkedAt: new Date().toISOString(),
    });
  }

  return patchData;
}

/**
 * 강제로 최신 패치노트 가져오기 (명령어용)
 */
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