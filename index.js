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

// Puppeteer로 스크린샷 + __NEXT_DATA__ 동시 추출
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
        try {
            const url = `https://www.gangnamunni.com/events?q=${encodeURIComponent(keyword)}`;
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

            // 스크린샷
            await page.screenshot({ path: `screenshots/${keyword}.png`, fullPage: true });
            console.log(`'${keyword}' 스크린샷 저장 완료`);

            // __NEXT_DATA__ 파싱
            const serviceOffers = await page.evaluate(() => {
                const el = document.getElementById('__NEXT_DATA__');
                if (!el) return [];
                const json = JSON.parse(el.textContent);
                return json.props?.pageProps?.data?.serviceOffers ?? [];
            });

            const totalCount = await page.evaluate(() => {
                const el = document.getElementById('__NEXT_DATA__');
                if (!el) return 0;
                const json = JSON.parse(el.textContent);
                return json.props?.pageProps?.data?.serviceOfferPagination?.recordsTotal ?? 0;
            });

            console.log(`'${keyword}' 전체 ${totalCount}개 중 상위 ${serviceOffers.length}개 로드`);

            const results = [];
            serviceOffers.forEach((item, index) => {
                const offer = item.serviceOffer;
                const clinicName = offer?.hospital?.name ?? '';
                if (clinicName.includes(TARGET_CLINIC_NAME)) {
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
        } catch (e) {
            console.error(`'${keyword}' 실패:`, e.message);
            resultsByKeyword[keyword] = [];
        }
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
        connectInfo: [
            {
                title: '🥇 강남언니 키워드별 순위',
                description: messageBody
            }
        ]
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
