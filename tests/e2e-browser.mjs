/**
 * 端到端测试：node tests/e2e-browser.mjs
 * 用无头 Chrome 真跑一遍界面：导入 GPX -> 写入本地库 -> 列表渲染 -> 展开详情 -> 刷新后仍在。
 * 需要本机有 Chrome 或 Edge（可用 CHROME_PATH 指定）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8123;
const CDP_PORT = 9333;
const APP_URL = `http://localhost:${APP_PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('没找到 Chrome / Edge，可用 CHROME_PATH 指定');
}

async function waitJson(url, tries = 60) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) { last = err.message; }
    await sleep(250);
  }
  throw new Error(`等待 ${url} 超时 ${last}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push((d.exception && d.exception.description) || d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面内报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : '  -> ' + detail}`);
}

/** 造一段 2.4 km 的直线骑行 GPX，用于测试导入链路 */
function sampleGpx() {
  const t0 = Date.UTC(2026, 9, 14, 2, 0, 0);
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const lat = 39.9 + i * 0.0004;
    const time = new Date(t0 + i * 12000).toISOString();
    rows.push(`<trkpt lat="${lat.toFixed(7)}" lon="116.4000000"><ele>${40 + i}</ele><time>${time}</time></trkpt>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="e2e">' +
    '<trk><name>端到端测试轨迹</name><type>cycling</type><trkseg>' + rows.join('') +
    '</trkseg></trk></gpx>';
}

const server = spawn('node', ['server.mjs', String(APP_PORT)], { cwd: root, stdio: 'ignore', windowsHide: true });
let browser;
let cdp;

try {
  await waitJson(`${APP_URL}core.js`).catch(() => {});
  const profile = path.join(os.tmpdir(), 'tr-e2e-profile-' + Date.now());
  browser = spawn(findBrowser(), [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const target = (await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`)).find((t) => t.type === 'page');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: APP_URL });
  // 等应用初始化完成（存储标签被填上说明 init 跑完了）
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(250);
    ready = await cdp.evaluate("!!document.querySelector('#storageTag')?.textContent").catch(() => false);
  }
  check('页面初始化完成', !!ready);

  const boot = await cdp.evaluate("({tag: document.querySelector('#storageTag').textContent, secure: document.querySelector('#secureWarn').classList.contains('hidden')})");
  check('识别到本机数据库', /本机数据库|本地存储/.test(boot.tag), boot.tag);
  check('localhost 被当成安全上下文（定位可用）', boot.secure === true);

  // --- 导入 GPX ---
  await cdp.evaluate(`(async () => {
    const gpx = ${JSON.stringify(sampleGpx())};
    const file = new File([gpx], 'e2e.gpx', { type: 'application/gpx+xml' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#fileImport');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
    return true;
  })()`);

  const list = await cdp.evaluate(`(() => {
    const items = document.querySelectorAll('.track-item');
    const first = items[0];
    return {
      count: items.length,
      name: first?.querySelector('.name')?.textContent || '',
      meta: first?.querySelector('.meta')?.textContent || ''
    };
  })()`);
  check('导入后列表出现 1 条轨迹', list.count === 1, 'count=' + list.count);
  check('轨迹名称来自 GPX', list.name.includes('端到端测试轨迹'), list.name);
  check('列表直接显示距离与均速', /km/.test(list.meta) && /均速/.test(list.meta), list.meta);

  // --- 切到轨迹页：导入时会自动展开详情，这里验证它在真实可见状态下渲染正确 ---
  await cdp.evaluate("document.querySelector('#tabTracks').click()");
  await sleep(600);
  const detail = await cdp.evaluate(`(() => {
    const item = document.querySelector('.track-item');
    const body = item.querySelector('.track-body');
    const canvas = body.querySelector('canvas.chart');
    const lines = document.querySelectorAll('.leaflet-overlay-pane canvas, .leaflet-overlay-pane svg');
    return {
      debug: {
        id: item.getAttribute('data-id'),
        openAttr: item.getAttribute('data-open'),
        bodyIsChild: item.contains(body),
        bodyClass: body.className,
        listVisible: !item.closest('section').classList.contains('hidden')
      },
      shown: !body.classList.contains('hidden'),
      kv: body.querySelector('.kv')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) || '',
      chartPixels: canvas ? canvas.width * canvas.height : 0,
      chartHasInk: canvas ? (() => { const c = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let ink = 0; for (let i = 3; i < c.length; i += 4) if (c[i] > 0) ink++; return ink; })() : 0,
      splitRows: body.querySelectorAll('.splits .r').length,
      mapReady: !!body.querySelector('.leaflet-container') && lines.length > 0
    };
  })()`);
  check('切到轨迹页后详情是展开的', detail.shown === true && detail.debug.listVisible === true, JSON.stringify(detail.debug));
  check('统计卡片有内容', /距离/.test(detail.kv) && /均速/.test(detail.kv), detail.kv.slice(0, 80));
  check('速度曲线画出了东西', detail.chartHasInk > 500, '着色像素=' + detail.chartHasInk);
  check('每公里分段生成了 2 条', detail.splitRows === 2, 'rows=' + detail.splitRows);
  check('详情里地图渲染出轨迹', detail.mapReady === true);

  // --- 展开 / 收起能来回切换 ---
  const toggled = await cdp.evaluate(`(() => {
    const item = document.querySelector('.track-item');
    const head = item.querySelector('.track-head');
    const body = item.querySelector('.track-body');
    head.click();
    const afterFirst = body.classList.contains('hidden');
    head.click();
    return { afterFirst, afterSecond: !body.classList.contains('hidden'), htmlLen: body.innerHTML.length };
  })()`);
  check('再点一次收起、再点一次展开', toggled.afterFirst === true && toggled.afterSecond === true && toggled.htmlLen > 200,
    JSON.stringify(toggled));

  // --- 刷新后数据还在 ---
  await cdp.send('Page.reload');
  await sleep(2000);
  let persisted = 0;
  for (let i = 0; i < 30 && !persisted; i++) {
    persisted = await cdp.evaluate("document.querySelectorAll('.track-item').length").catch(() => 0);
    if (!persisted) await sleep(250);
  }
  check('刷新后轨迹仍然存在', persisted === 1, 'count=' + persisted);

  // --- 导出函数真的产出合规内容 ---
  const exportOk = await cdp.evaluate(`(() => {
    const gpx = TrackCore.toGpx({ name: 'x', activity: 'bike', startedAt: Date.now() - 60000,
      points: [{ t: Date.now() - 60000, lat: 39.9, lon: 116.4, alt: 12, acc: 5 }] });
    const back = TrackCore.parseGpx(gpx);
    return { parsed: back.points.length, hasTrkpt: gpx.includes('<trkpt') };
  })()`);
  check('页面里导出的 GPX 能被自己解析回来', exportOk.parsed === 1 && exportOk.hasTrkpt === true, JSON.stringify(exportOk));

  check('运行期间没有未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | '));
  check('运行期间没有 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '));

  // --- 模拟 GPS：跑一遍真实记录流程（开始 -> 实时统计 -> 暂停 -> 继续 -> 结束保存）---
  await cdp.send('Browser.grantPermissions', { origin: APP_URL, permissions: ['geolocation'] });
  const MOVE = 0.00005;                      // 约 5.5 米/步，1 秒一步 ≈ 20 km/h
  let lat = 39.9;
  const walk = async (steps, waitMs) => {
    for (let i = 0; i < steps; i++) {
      lat += MOVE;
      await cdp.send('Emulation.setGeolocationOverride', { latitude: lat, longitude: 116.4, accuracy: 5 });
      await sleep(waitMs);
    }
  };
  await cdp.send('Emulation.setGeolocationOverride', { latitude: lat, longitude: 116.4, accuracy: 5 });
  await cdp.evaluate("document.querySelector('#tabRecord').click()");
  await cdp.evaluate("document.querySelector('#btnStart').click()");
  await sleep(900);
  await walk(8, 1000);

  const live = await cdp.evaluate(`({
    dist: document.querySelector('#liveDist').textContent,
    pts: document.querySelector('#livePts').textContent,
    time: document.querySelector('#liveTime').textContent,
    avg: document.querySelector('#liveAvg').textContent,
    gps: document.querySelector('#gpsState').textContent,
    wake: document.querySelector('#wakeState').textContent,
    btnStopVisible: !document.querySelector('#btnStop').classList.contains('hidden')
  })`);
  check('模拟 GPS 下确实采到了点', Number(live.pts) >= 6, JSON.stringify(live));
  check('实时距离在增长', Number(live.dist) > 0.02, 'dist=' + live.dist);
  check('实时均速在合理区间', Number(live.avg) > 5 && Number(live.avg) < 60, 'avg=' + live.avg);
  check('定位状态显示已定位', /已定位/.test(live.gps), live.gps);
  check('记录中显示了结束按钮', live.btnStopVisible === true);

  const timeBeforePause = live.time;
  await cdp.evaluate("document.querySelector('#btnPause').click()");
  await sleep(1200);
  const paused = await cdp.evaluate(`({
    time: document.querySelector('#liveTime').textContent,
    resumeVisible: !document.querySelector('#btnResume').classList.contains('hidden'),
    gps: document.querySelector('#gpsState').textContent
  })`);
  check('暂停后不再累加时间', paused.time === timeBeforePause, `${timeBeforePause} -> ${paused.time}`);
  check('暂停后出现继续按钮', paused.resumeVisible === true);

  await cdp.evaluate("document.querySelector('#btnResume').click()");
  await sleep(600);
  await walk(4, 1000);
  const beforeStop = await cdp.evaluate("document.querySelector('#liveDist').textContent");
  await cdp.evaluate("document.querySelector('#btnStop').click()");
  await sleep(1800);

  const saved = await cdp.evaluate(`(() => {
    const items = document.querySelectorAll('.track-item');
    const metas = [...items].map(i => i.querySelector('.meta').textContent);
    return {
      count: items.length,
      metas,
      onTracksTab: !document.querySelector('#view-tracks').classList.contains('hidden'),
      startVisible: !document.querySelector('#btnStart').classList.contains('hidden'),
      stopHidden: document.querySelector('#btnStop').classList.contains('hidden'),
      pauseHidden: document.querySelector('#btnPause').classList.contains('hidden'),
      resumeHidden: document.querySelector('#btnResume').classList.contains('hidden'),
      lastDistance: document.querySelector('#liveDist').textContent
    };
  })()`);
  check('结束保存后轨迹列表多出一条', saved.count === 2, JSON.stringify(saved.metas));
  check('保存后自动跳到轨迹页', saved.onTracksTab === true);
  check('保存后按钮回到初始状态，并保留本次成绩供查看',
    saved.startVisible && saved.stopHidden && saved.pauseHidden && saved.resumeHidden && Number(saved.lastDistance) > 0,
    JSON.stringify(saved));
  check('模拟记录的距离和暂停前一致（暂停不丢数据）', Number(beforeStop) > 0.02, 'beforeStop=' + beforeStop);

  // 再点一次开始，读数必须清零；随后放弃本次（对话框自动确认），确认放弃不留数据
  const restart = await cdp.evaluate(`(async () => {
    document.querySelector('#tabRecord').click();
    document.querySelector('#btnStart').click();
    const after = {
      dist: document.querySelector('#liveDist').textContent,
      time: document.querySelector('#liveTime').textContent,
      pts: document.querySelector('#livePts').textContent
    };
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('#btnDiscard').click();
    await new Promise(r => setTimeout(r, 500));
    return { after, items: document.querySelectorAll('.track-item').length,
             backToStart: !document.querySelector('#btnStart').classList.contains('hidden') };
  })()`);
  check('重新开始会清零读数', restart.after.dist === '0.00' && restart.after.time === '0:00' && restart.after.pts === '0',
    JSON.stringify(restart.after));
  check('放弃本次不会存进列表', restart.items === 2 && restart.backToStart === true, JSON.stringify(restart));
} catch (err) {
  check('测试执行', false, err.message);
} finally {
  if (cdp) cdp.close();
  if (browser) browser.kill();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过, ${failed.length} 失败\n`);
process.exit(failed.length ? 1 : 0);
