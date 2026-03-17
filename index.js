require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const JANDI_WEBHOOK_URL = process.env.JANDI_WEBHOOK_URL;
const TARGET_CLINIC_NAME = 'TU치과의원';
const KEYWORDS = [
    '라미네이트',
    '임플란트',
    '치아미백',
    '잇몸성형',
    '돌출입교정',
    '설측교정',
    '치아교정',
    '투명교정'
];
const API_URL = 'https://www.gangnamunni.com/api/solar/display/search-view/web/service-offers';

if (!JANDI_WEBHOOK_URL) {
    console.error('JANDI_WEBHOOK_URL 환경 변수를 설정해야 합니다.');
    process.exit(1);
}

const GITHUB_REPO_URL = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${process.env.GITHUB_REF_NAME}`;

// Puppeteer로 token 쿠키 추출 + 스크린샷
async function getTokenAndScreenshots() {
    if (!fs.existsSync('screenshots')) {
        fs.mkdirSync('screenshots', { recursive: true });
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920,1080',
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    // 첫 페이지 로드해서 token 쿠키 획득
    await page.goto(`https://www.gangnamunni.com/events?q=${encodeURIComponent(KEYWORDS[0])}`, {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

    const cookies = await page.cookies();
    const token = cookies.find(c => c.name === 'token')?.value;
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log('token 획득:', token ? '성공' : '실패');

    // 스크린샷 (첫 번째 키워드는 이미 로드됨)
    await page.screenshot({ path: `screenshots/${KEYWORDS[0]}.png`, fullPage: true });
    console.log(`'${KEYWORDS[0]}' 스크린샷 저장 완료`);

    for (const keyword of KEYWORDS.slice(1)) {
        try {
            await page.goto(`https://www.gangnamunni.com/events?q=${encodeURIComponent(keyword)}`, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            await page.screenshot({ path: `screenshots/${keyword}.png`, fullPage: true });
            console.log(`'${keyword}' 스크린샷 저장 완료`);
        } catch (e) {
            console.error(`'${keyword}' 스크린샷 실패:`, e.message);
        }
    }

    await browser.close();
    return { token, cookieStr };
}

// token으로 API 직접 호출
async function fetchKeywordResults(keyword, token, cookieStr) {
    const allItems = [];
    let pageIndex = 0;
    let hasMore = true;

    while (hasMore) {
        const res = await axios.post(API_URL,
            {
                keyword,
                filters: { hospital: { district: { neighborhoodVicinityCodes: [] } } },
                pagination: { pageIndex, pageSize: 20, sort: 'RECOMMENDATION' }
            },
            {
                headers: {
                    'authorization': `${token}, ${token}`,
                    'devicetype': 'WEB',
                    'x-accept-language': 'ko-KR',
                    'accept-language': 'ko-KR',
                    'content-type': 'application/json',
                    'accept': 'application/json, text/plain, */*',
                    'cookie': cookieStr,
                    'origin': 'https://www.gangnamunni.com',
                    'referer': `https://www.gangnamunni.com/events?q=${encodeURIComponent(keyword)}`,
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                }
            }
        );

        const data = res.data;
        const items = data?.contents ?? [];
        const totalCount = data?.totalElementNumber ?? 0;

        if (pageIndex === 0) {
            console.log(`'${keyword}' 전체 ${totalCount}개`);
        }

        if (!items || items.length === 0) break;
        allItems.push(...items);
        pageIndex++;

        if (data?.isLastPage === true || allItems.length >= totalCount) hasMore = false;
    }

    const results = [];
    allItems.forEach((item, index) => {
        const offer = item.serviceOffer;
        if ((offer?.hospital?.name ?? '').includes(TARGET_CLINIC_NAME)) {
            results.push({
                rank: index + 1,
                eventName: offer?.title ?? 'N/A',
                starRating: offer?.rating?.amount ?? 'N/A',
                reviewCount: offer?.rating?.count ?? 'N/A',
            });
        }
    });

    return results;
}

async function sendJandiNotification(results) {
    console.log('Jandi로 결과 전송 중...');

    let messageBody = '';
    for (const keyword of KEYWORDS) {
        messageBody += `### 🦷 ${keyword}\n`;
        const screenshotUrl = `${GITHUB_REPO_URL}/screenshots/${encodeURIComponent(keyword)}.png`;

        if (results[keyword] && results[keyword].length > 0) {
            results[keyword].forEach(item => {
                messageBody += `**[${item.eventName}]**\n`;
                messageBody += `* 순위: **${item.rank}위**\n`;
                messageBody += `* 별점: ${item.starRating}\n`;
                messageBody += `* 리뷰: ${item.reviewCount}\n`;
            });
        } else {
            messageBody += '❌ **리스트에 없음**\n';
        }
        messageBody += `[스크린샷 보기](${screenshotUrl})\n\n`;
    }

    const payload = {
        body: `📢 강남언니 키워드 순위 리포트 (${new Date().toLocaleDateString('ko-KR')})`,
        connectColor: '#00B8D9',
        connectInfo: [{ title: '🥇 강남언니 키워드별 순위', description: messageBody }]
    };

    try {
        await axios.post(JANDI_WEBHOOK_URL, payload, {
            headers: {
                'Accept': 'application/vnd.tosslab.jandi-v2+json',
                'Content-Type': 'application/json'
            }
        });
        console.log('Jandi 알림 전송 성공');
    } catch (error) {
        console.error('Jandi 알림 전송 실패:', error.message);
    }
}

async function main() {
    console.log('강남언니 키워드 순위 확인 시작');

    // 1. Puppeteer로 token + 쿠키 획득 + 스크린샷
    const { token, cookieStr } = await getTokenAndScreenshots();

    if (!token) {
        console.error('token 획득 실패 - 종료');
        process.exit(1);
    }

    // 2. API로 키워드별 순위 수집
    const resultsByKeyword = {};
    for (const keyword of KEYWORDS) {
        console.log(`'${keyword}' API 조회 중...`);
        try {
            resultsByKeyword[keyword] = await fetchKeywordResults(keyword, token, cookieStr);
            console.log(`'${keyword}' 완료: ${resultsByKeyword[keyword].length}개 결과`);
        } catch (e) {
            console.error(`'${keyword}' 조회 실패:`, e.message, e.response?.status);
            resultsByKeyword[keyword] = [];
        }
    }

    // 3. Jandi 알림 전송
    await sendJandiNotification(resultsByKeyword);

    console.log('작업 완료');
}

main().catch(error => {
    console.error('스크립트 실행 중 오류 발생:', error);
    process.exit(1);
});
