const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// ✅ 修复1：截图目录提前统一定义，避免各处重复定义导致未定义报错
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] 消息已发送。');
    } catch (e) {
        console.error('[Telegram] 发送消息失败:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] 正在发送图片...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 发送图片失败:', err.message);
                else console.log('[Telegram] 图片已发送。');
                resolve();
            });
        });
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

// ✅ 修复2：增强版注入脚本，同时 hook attachShadow 和直接扫描现有 DOM
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    function reportCheckbox(checkbox) {
        const rect = checkbox.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
            window.__turnstile_data = {
                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                yRatio: (rect.top + rect.height / 2) / window.innerHeight
            };
            return true;
        }
        return false;
    }

    function scanForCheckbox(root) {
        // 直接查找普通 checkbox
        const cb = root.querySelector('input[type="checkbox"]');
        if (cb && reportCheckbox(cb)) return true;
        // 递归查找所有 shadow root
        const all = root.querySelectorAll('*');
        for (const el of all) {
            if (el.shadowRoot) {
                const scb = el.shadowRoot.querySelector('input[type="checkbox"]');
                if (scb && reportCheckbox(scb)) return true;
            }
        }
        return false;
    }

    // Hook attachShadow（捕获新创建的 shadow root）
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                if (!scanForCheckbox(shadowRoot)) {
                    const observer = new MutationObserver(() => {
                        if (scanForCheckbox(shadowRoot)) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }

    // 也对整个 document 做轮询扫描（兜底，应对 shadow root 已存在的情况）
    let scanCount = 0;
    const scanInterval = setInterval(() => {
        if (window.__turnstile_data || scanCount++ > 30) {
            clearInterval(scanInterval);
            return;
        }
        scanForCheckbox(document);
    }, 500);
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => { resolve(true); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage',
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动失败');
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }

    // ✅ 修复3：兜底策略——直接在 frame 里用 JS 点击 checkbox
    for (const frame of frames) {
        try {
            const clicked = await frame.evaluate(() => {
                const cb = document.querySelector('input[type="checkbox"]');
                if (cb) { cb.click(); return true; }
                // 查找 shadow root 里的 checkbox
                for (const el of document.querySelectorAll('*')) {
                    if (el.shadowRoot) {
                        const scb = el.shadowRoot.querySelector('input[type="checkbox"]');
                        if (scb) { scb.click(); return true; }
                    }
                }
                return false;
            }).catch(() => false);
            if (clicked) {
                console.log('>> [兜底] 通过 JS click() 点击了 checkbox。');
                return true;
            }
        } catch (e) { }
    }

    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) { console.error('连接失败。退出。'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        // ✅ 修复1关键点：safeUsername 在用户循环顶部统一定义
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');

        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录 ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                console.log('   >> 正在登录前检查 Turnstile...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }

                if (cdpClickResult) {
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        let isSuccess = false;
                        for (const f of page.frames()) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true; break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) { console.log('   >> 登录前 Turnstile 验证成功。'); break; }
                        await page.waitForTimeout(1000);
                    }
                }

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 账号或密码错误`);
                        const failShotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}_login_failed.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }
                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录错误:', e.message);
            }

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮。');
                continue;
            }

            // --- Renew 主循环 ---
            let renewSuccess = false;

            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    console.log('正在检查 Turnstile...');
                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 30; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) break;
                        console.log(`   >> [寻找尝试 ${findAttempt + 1}/30] 尚未找到 Turnstile 复选框...`);
                        await page.waitForTimeout(1000);
                    }

                    if (cdpClickResult) {
                        console.log('   >> CDP 点击生效。等待 8秒 Cloudflare 检查...');
                        await page.waitForTimeout(8000);
                    } else {
                        console.log('   >> 重试后仍未确认 Turnstile 复选框。');
                    }

                    let isTurnstileSuccess = false;
                    for (const f of page.frames()) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                    console.log('   >> 在 Turnstile iframe 中检测到 "Success!"。');
                                    isTurnstileSuccess = true;
                                    break;
                                }
                            } catch (e) { }
                        }
                    }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {
                        const tsScreenshotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}_Turnstile_${attempt}.png`);
                        try {
                            await page.screenshot({ path: tsScreenshotPath, fullPage: true });
                            console.log(`   >> 📸 快照已保存: ${safeUsername}_Turnstile_${attempt}.png`);
                        } catch (e) { }

                        console.log('   >> 点击 Renew 确认按钮...');
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到验证码错误。');
                                    hasCaptchaError = true;
                                    break;
                                }
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    const dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    const skipShotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }
                                    await sendTelegramMessage(`⏳ *暂无法续期*\n用户: ${user.username}\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true;
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            console.log('   >> 刷新页面重置 Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ 模态框已关闭，续期成功！');
                            const successShotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }
                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的确认按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                } else {
                    console.log('未找到 Renew 按钮（服务器可能已续期或页面加载错误）。');
                    break;
                }
            }

            // ✅ 修复4：20次全部失败时也发 TG 通知
            if (!renewSuccess) {
                const failShotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}_failed.png`);
                try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`❌ *续期失败*\n用户: ${user.username}\n原因: 20次尝试后仍未通过 Turnstile 验证`, failShotPath);
            }

        } catch (err) {
            console.error(`处理用户时发生错误:`, err);
            // ✅ 修复5：异常时也发 TG 通知
            const errShotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}_error.png`);
            try { await page.screenshot({ path: errShotPath, fullPage: true }); } catch (e) { }
            await sendTelegramMessage(`⚠️ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, errShotPath);
        }

        const screenshotPath = path.join(SCREENSHOTS_DIR, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
