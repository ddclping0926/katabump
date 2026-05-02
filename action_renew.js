const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] 消息已发送。');
    } catch (e) {
        console.error('[Telegram] 发送消息失败:', e.message);
    }
    if (imagePath && fs.existsSync(imagePath)) {
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
        console.log(`[代理] 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

// 注入脚本：仅做 screenX/Y 伪装，不再依赖 attachShadow hook
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const screenX = Math.floor(Math.random() * 400) + 800;
        const screenY = Math.floor(Math.random() * 200) + 400;
        Object.defineProperty(MouseEvent.prototype, 'screenX', { get: () => screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { get: () => screenY });
    } catch (e) {}
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username) axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (e) {
        console.error(`[代理] 连接失败: ${e.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已运行。'); return; }
    console.log(`启动 Chrome (${CHROME_PATH})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--window-size=1280,720',
        '--no-sandbox', '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage',
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动失败');
    console.log('Chrome 已就绪。');
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) { console.error('解析 USERS_JSON 错误:', e); }
    return [];
}

/**
 * 新版 Turnstile 处理：
 * 找到 Cloudflare iframe → 获取其在页面上的位置 → 
 * 用 CDP 在 iframe 左侧区域（checkbox 通常在这里）发送真实鼠标事件
 */
async function handleTurnstile(page, timeoutMs = 30000) {
    console.log('   >> 开始查找 Turnstile iframe...');
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        for (const frame of page.frames()) {
            const url = frame.url();
            if (!url.includes('challenges.cloudflare.com') && !url.includes('turnstile')) continue;

            try {
                const iframeEl = await frame.frameElement();
                if (!iframeEl) continue;
                const box = await iframeEl.boundingBox();
                if (!box || box.width < 10) continue;

                console.log(`   >> 找到 Turnstile iframe: x=${box.x.toFixed(0)}, y=${box.y.toFixed(0)}, w=${box.width.toFixed(0)}, h=${box.height.toFixed(0)}`);

                const clickY = box.y + box.height / 2;
                // 先用 page.mouse 模拟真实鼠标（xvfb 环境下更自然）
                // checkbox 通常在 iframe 左边 10-30px 内
                for (const offsetX of [12, 20, 28]) {
                    const clickX = box.x + offsetX;
                    await page.mouse.move(box.x + box.width / 2, box.y - 10); // 先移到 iframe 外
                    await new Promise(r => setTimeout(r, 200 + Math.random() * 200));
                    await page.mouse.move(clickX, clickY, { steps: 8 }); // 缓慢移入
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
                    await page.mouse.click(clickX, clickY, { delay: 80 + Math.random() * 60 });
                    console.log(`   >> mouse.click (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);
                    await new Promise(r => setTimeout(r, 500));
                }

                // 等待验证结果，最多 12 秒
                console.log('   >> 等待 Cloudflare 验证结果（最多12秒）...');
                for (let w = 0; w < 12; w++) {
                    await page.waitForTimeout(1000);

                    // 方式1：检查 iframe 内 Success 文字
                    try {
                        const successVisible = await frame.evaluate(() => {
                            return document.body?.innerText?.includes('Success') || false;
                        }).catch(() => false);
                        if (successVisible) {
                            console.log('   >> ✅ Turnstile 验证成功（检测到 Success）');
                            return true;
                        }
                    } catch (e) {}

                    // 方式2：检查主页面隐藏 input 的值是否是有效 token（以 0. 开头的长字符串）
                    try {
                        const hasToken = await page.evaluate(() => {
                            const inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
                            for (const el of inputs) {
                                // 有效 token 通常以 "0." 开头且长度超过 100
                                if (el.value && el.value.startsWith('0.') && el.value.length > 100) {
                                    return true;
                                }
                            }
                            return false;
                        }).catch(() => false);
                        if (hasToken) {
                            console.log('   >> ✅ Turnstile 验证成功（检测到有效 token）');
                            return true;
                        }
                    } catch (e) {}
                }

                console.log('   >> ⚠️ 等待超时，验证结果未知，继续流程...');
                return false;

            } catch (e) {
                // 忽略单个 frame 的错误，继续找下一个
            }
        }
        await page.waitForTimeout(500);
    }

    console.log('   >> ⚠️ 未找到 Turnstile iframe（超时）');
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) { console.log('未找到用户'); process.exit(1); }

    if (PROXY_CONFIG && !await checkProxy()) {
        console.error('[代理] 无效，终止。');
        process.exit(1);
    }

    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('Chrome 连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败，2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) { console.error('无法连接 Chrome，退出。'); process.exit(1); }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG?.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else {
        await context.setHTTPCredentials(null);
    }

    await context.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n${'='.repeat(40)}`);
        console.log(`正在处理用户 ${i + 1}/${users.length}`);
        console.log('='.repeat(40));

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
            const emailInput = page.getByRole('textbox', { name: 'Email' });
            await emailInput.waitFor({ state: 'visible', timeout: 10000 });
            await emailInput.fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
            await page.waitForTimeout(800);

            // 处理登录页 Turnstile，最多重试3次
            let turnstileOk = false;
            for (let tr = 0; tr < 3; tr++) {
                turnstileOk = await handleTurnstile(page, 20000);
                if (turnstileOk) break;
                if (tr < 2) console.log(`   >> Turnstile 第 ${tr + 1} 次未确认，稍候重试...`);
            }

            await page.getByRole('button', { name: 'Login', exact: true }).click();
            await page.waitForTimeout(4000);

            // 检查当前 URL 判断登录结果
            const currentUrl = page.url();
            console.log('   >> 登录后 URL:', currentUrl);

            if (currentUrl.includes('error=captcha')) {
                console.error('   >> ❌ 登录失败：Turnstile 验证未通过');
                const shot = path.join(SCREENSHOTS_DIR, `${safeUsername}_captcha_failed.png`);
                await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: Cloudflare Turnstile 验证未通过`, shot);
                continue;
            }

            if (await page.getByText('Incorrect password or no account').isVisible().catch(() => false)) {
                console.error('   >> ❌ 登录失败：账号或密码错误');
                const shot = path.join(SCREENSHOTS_DIR, `${safeUsername}_login_failed.png`);
                await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, shot);
                continue;
            }

            if (currentUrl.includes('login')) {
                console.error('   >> ❌ 登录失败：仍在登录页');
                const shot = path.join(SCREENSHOTS_DIR, `${safeUsername}_login_check.png`);
                await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 未能进入 Dashboard`, shot);
                continue;
            }

            console.log('   >> ✅ 登录成功，已进入 Dashboard');

            // 寻找 See 链接
            console.log('正在寻找 "See" 链接...');
            console.log('   >> 当前 URL:', page.url());
            try {
                // 等待页面稳定
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
                const seeLink = page.getByRole('link', { name: 'See' }).first();
                await seeLink.waitFor({ timeout: 20000 });
                // 滚动到元素确保可见
                await seeLink.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
                await seeLink.click();
                console.log('   >> "See" 链接已点击');
                await page.waitForTimeout(2000);
            } catch (e) {
                console.log('未找到 "See" 链接:', e.message);
                // 打印页面所有链接帮助诊断
                const links = await page.evaluate(() =>
                    Array.from(document.querySelectorAll('a')).map(a => a.innerText.trim()).filter(t => t)
                ).catch(() => []);
                console.log('   >> 页面现有链接:', links.slice(0, 20).join(' | '));
                continue;
            }

            // --- Renew 主循环 ---
            let renewSuccess = false;

            for (let attempt = 1; attempt <= 20; attempt++) {
                console.log(`\n[尝试 ${attempt}/20] 寻找 Renew 按钮...`);
                let hasCaptchaError = false;

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}

                if (!await renewBtn.isVisible().catch(() => false)) {
                    console.log('未找到 Renew 按钮（可能已续期）。');
                    break;
                }

                await renewBtn.click();
                console.log('Renew 按钮已点击，等待模态框...');

                // 等待 #renew-modal 变为 visible（最多10秒）
                const modal = page.locator('#renew-modal');
                let modalVisible = false;
                try {
                    await modal.waitFor({ state: 'visible', timeout: 10000 });
                    modalVisible = await modal.isVisible();
                } catch(e) {}

                // 截图看模态框实际状态
                const preShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_modal_check_${attempt}.png`);
                await page.screenshot({ path: preShot, fullPage: true }).catch(() => {});

                const allFrameUrls = page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank');
                console.log('   >> frame URLs:', allFrameUrls.join(' | '));
                console.log(`   >> #renew-modal visible: ${modalVisible}`);

                // 打印模态框的 display 样式帮助诊断
                const modalDisplay = await page.evaluate(() => {
                    const el = document.querySelector('#renew-modal');
                    if (!el) return 'not found';
                    return window.getComputedStyle(el).display + ' / ' + el.style.display;
                }).catch(() => 'error');
                console.log(`   >> #renew-modal display: ${modalDisplay}`);

                if (!modalVisible) {
                    console.log('   >> 模态框未显示，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                // 在模态框内移动鼠标
                try {
                    const box = await modal.boundingBox();
                    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                } catch (e) {}

                // 等待 Turnstile 加载
                await page.waitForTimeout(2000);

                // 处理 Turnstile
                await handleTurnstile(page, 35000);

                // 截图
                const tsShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_attempt_${attempt}.png`);
                await page.screenshot({ path: tsShot, fullPage: true }).catch(() => {});
                console.log(`   >> 📸 截图已保存: ${safeUsername}_attempt_${attempt}.png`);

                // 点击确认：在模态框内找 Renew 按钮，找不到就在整个页面找
                let confirmBtn = modal.getByRole('button', { name: 'Renew' });
                if (!await confirmBtn.isVisible().catch(() => false)) {
                    confirmBtn = page.getByRole('button', { name: 'Confirm' }).first();
                }
                if (!await confirmBtn.isVisible().catch(() => false)) {
                    confirmBtn = page.getByRole('button', { name: 'Renew', exact: true }).last();
                }

                if (!await confirmBtn.isVisible().catch(() => false)) {
                    console.log('   >> 确认按钮未找到，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                console.log('   >> 点击确认 Renew...');
                await confirmBtn.click();

                // 检查结果
                const checkStart = Date.now();
                while (Date.now() - checkStart < 5000) {
                    if (await page.getByText('Please complete the captcha to continue').isVisible().catch(() => false)) {
                        console.log('   >> ⚠️ 验证码错误，刷新重试...');
                        hasCaptchaError = true;
                        break;
                    }
                    if (await page.getByText("You can't renew your server yet").isVisible().catch(() => false)) {
                        const text = await page.getByText("You can't renew your server yet").innerText().catch(() => '');
                        const match = text.match(/as of\s+(.*?)\s+\(/);
                        const dateStr = match ? match[1] : '未知日期';
                        console.log(`   >> ⏳ 还未到续期时间，下次可用: ${dateStr}`);
                        const skipShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_skip.png`);
                        await page.screenshot({ path: skipShot, fullPage: true }).catch(() => {});
                        await sendTelegramMessage(`⏳ *暂无法续期*\n用户: ${user.username}\n下次可用: ${dateStr}`, skipShot);
                        renewSuccess = true;
                        try { if (await modal.getByLabel('Close').isVisible()) await modal.getByLabel('Close').click(); } catch (e) {}
                        break;
                    }
                    await page.waitForTimeout(300);
                }

                if (renewSuccess) break;
                if (hasCaptchaError) {
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                await page.waitForTimeout(2000);
                const modalStillVisible = await modal.isVisible().catch(() => false);
                if (!modalStillVisible) {
                    console.log('   >> ✅ 模态框关闭，续期成功！');
                    const successShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_success.png`);
                    await page.screenshot({ path: successShot, fullPage: true }).catch(() => {});
                    await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShot);
                    renewSuccess = true;
                    break;
                } else {
                    console.log('   >> 模态框仍打开，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                }
            }

            if (!renewSuccess) {
                const failShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_failed.png`);
                await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
                await sendTelegramMessage(`❌ *续期失败*\n用户: ${user.username}\n原因: 20次尝试后仍未通过 Turnstile 验证`, failShot);
            }

        } catch (err) {
            console.error('处理用户时发生错误:', err.message);
            const errShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_error.png`);
            await page.screenshot({ path: errShot, fullPage: true }).catch(() => {});
            await sendTelegramMessage(`⚠️ *处理异常*\n用户: ${user.username}\n错误: ${err.message}`, errShot);
        }

        const finalShot = path.join(SCREENSHOTS_DIR, `${safeUsername}_final.png`);
        await page.screenshot({ path: finalShot, fullPage: true }).catch(() => {});
        console.log(`用户处理完成\n`);
    }

    console.log('所有用户处理完毕。');
    await browser.close();
    process.exit(0);
})();
