require('dotenv').config();
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');

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

async function main() {
    // 스크린샷 디렉토리 생성
    if (!fs.existsSync('screenshots')) {
        fs.mkdirSync('screenshots', { recursive: true });
    }

    console.log('강남언니 키워드 순위 확인 시작');
    const resultsByKeyword = {};

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    const page = await browser.newPage();

    // 봇 탐지 우회 설정: webdriver 프로퍼티 숨기기
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
        });
    });

    // 봇 탐지 우회를 위한 User-Agent 및 헤더 설정
    // robots.txt에서 허용하는 Googlebot으로 위장
    await page.setUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' });

    // 디버깅을 위해 브라우저 콘솔 로그를 Node.js 터미널로 출력
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.setViewport({ width: 1280, height: 800 });

    // 메인 페이지 접속 테스트
    console.log('메인 페이지 접속 테스트 중...');
    try {
        const mainResponse = await page.goto('https://www.gangnamunni.com/', { waitUntil: 'networkidle0' });
        console.log(`메인 페이지 응답 코드: ${mainResponse.status()}`);
        await page.screenshot({ path: 'screenshots/main_page_test.png' });
    } catch (e) {
        console.error('메인 페이지 접속 실패:', e);
    }

    for (const keyword of KEYWORDS) {
        // 첫 번째 키워드가 아니면 검색 전에 잠시 대기 (봇 탐지 방지)
        if (keyword !== KEYWORDS[0]) {
            const delayTime = Math.floor(Math.random() * 3000) + 2000; // 2초 ~ 5초 랜덤 대기
            console.log(`봇 탐지 방지를 위해 ${delayTime}ms 대기...`);
            await new Promise(r => setTimeout(r, delayTime));
        }

        console.log(`'${keyword}' 키워드 검색 중...`);
        const url = `https://www.gangnamunni.com/events?q=${encodeURIComponent(keyword)}`;
        const response = await page.goto(url, { waitUntil: 'networkidle0' });
        console.log(`'${keyword}' 응답 코드: ${response.status()}`);

        // 스크린샷 저장
        const screenshotPath = `screenshots/${keyword}.png`;
        await page.screenshot({ path: screenshotPath });

        const results = await page.evaluate((TARGET_CLINIC_NAME) => {
            const scrapedData = [];
            // XPath를 절대 경로에서 상대 경로로 변경하여 구조 변경에 유연하게 대응 (메인 영역 내의 리스트 아이템)
            const eventNodes = document.evaluate('//main//ul/div/a', document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
            
            let node;
            let rank = 1;
            while ((node = eventNodes.iterateNext())) {
                const clinicNameNode = document.evaluate('.//div/div[1]/div[1]/span', node, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                
                // 병원 이름이 포함되어 있는지 확인 (부분 일치 허용)
                if (clinicNameNode && clinicNameNode.textContent.includes(TARGET_CLINIC_NAME)) {
                    const eventNameNode = document.evaluate('.//div/div[1]/div[1]/h2', node, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    const starRatingNode = document.evaluate('.//div/div[1]/div[2]/span[1]', node, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    const reviewCountNode = document.evaluate('.//div/div[1]/div[2]/span[2]', node, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;

                    scrapedData.push({
                        rank: rank,
                        eventName: eventNameNode ? eventNameNode.textContent.trim() : 'N/A',
                        starRating: starRatingNode ? starRatingNode.textContent.trim() : 'N/A',
                        reviewCount: reviewCountNode ? reviewCountNode.textContent.trim() : 'N/A',
                    });
                }
                rank++;
            }
            return scrapedData;
        }, TARGET_CLINIC_NAME);

        resultsByKeyword[keyword] = results;
    }

    await browser.close();

    await sendJandiNotification(resultsByKeyword);
    
    console.log('작업 완료');
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
            messageBody += '리스트에 없음\n';
        }
        messageBody += `[스크린샷 보기](${screenshotUrl})\n\n`;
    }

    if (messageBody === '') {
        messageBody = '금일 강남언니 이벤트 목록에서 해당 병원을 찾지 못했습니다.';
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

main().catch(error => {
    console.error('스크립트 실행 중 오류 발생:', error);
    process.exit(1);
});
