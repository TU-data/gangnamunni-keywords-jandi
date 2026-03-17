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

if (!JANDI_WEBHOOK_URL) {
    console.error('JANDI_WEBHOOK_URL 환경 변수를 설정해야 합니다.');
    process.exit(1);
}

const GITHUB_REPO_URL = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${process.env.GITHUB_REF_NAME}`;

async function scrapeAll() {
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

    const resultsByKeyword = {};

    for (const keyword of KEYWORDS) {
        const allItems = [];

        // API 응답 인터셉트
        const onResponse = async (response) => {
            if (response.url().includes('service-offers')) {
                try {
                    const data = await response.json();
                    const items = data?.contents ?? [];
                    if (items.length > 0) {
                        allItems.push(...items);
                        console.log(`'${keyword}' API 응답: ${items.length}개 (누적 ${allItems.length}개)`);
                    }
                } catch (e) {}
            }
        };
        page.on('response', onResponse);

        try {
            await page.goto(`https://www.gangnamunni.com/events?q=${encodeURIComponent(keyword)}`, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            // 스크린샷
            await page.screenshot({ path: `screenshots/${keyword}.png`, fullPage: true });
            console.log(`'${keyword}' 스크린샷 저장 완료`);

            // 더보기 클릭
            await page.evaluate(() => {
                const xpath = '//main//a[contains(text(), "더보기")]';
                const link = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (link) link.click();
            });
            await new Promise(r => setTimeout(r, 2000));

            // 스크롤로 전체 로드
            let prevHeight = 0;
            for (let i = 0; i < 15; i++) {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await new Promise(r => setTimeout(r, 2000));
                const height = await page.evaluate(() => document.body.scrollHeight);
                if (height === prevHeight) break;
                prevHeight = height;
            }

        } catch (e) {
            console.error(`'${keyword}' 실패:`, e.message);
        }

        page.off('response', onResponse);

        // TU치과의원 순위 추출
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

        resultsByKeyword[keyword] = results;
        console.log(`'${keyword}' 완료: ${results.length}개 결과`);
    }

    await browser.close();
    return resultsByKeyword;
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
    const resultsByKeyword = await scrapeAll();
    await sendJandiNotification(resultsByKeyword);
    console.log('작업 완료');
}

main().catch(error => {
    console.error('스크립트 실행 중 오류 발생:', error);
    process.exit(1);
});
