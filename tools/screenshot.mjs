/**
 * 生成预览图：node tools/screenshot.mjs
 * 输出 preview-record.png（记录页）和 preview-track.png（轨迹详情页）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8124;
const CDP_PORT = 9444;
const URL_APP = `http://localhost:${PORT}/`;
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
  throw new Error('没找到 Chrome / Edge');
}

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(250);
  }
  throw new Error('等待超时 ' + url);
}

const server = spawn('node', ['server.mjs', String(PORT)], { cwd: root, stdio: 'ignore', windowsHide: true });
const browser = spawn(findBrowser(), [
  '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'tr-shot-' + Date.now())}`, 'about:blank'
], { stdio: 'ignore', windowsHide: true });

let ws;
try {
  await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const target = (await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`)).find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || {}); pending.delete(msg.id); }
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  }
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(root, file), Buffer.from(r.data, 'base64'));
    console.log('已生成 ' + file);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 880, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL_APP });
  await sleep(3000);
  await evaluate("document.querySelector('#tabRecord').click()");
  await sleep(2500);
  await shot('preview-record.png');

  const gpx = await evaluate(`(() => {
    const t0 = Date.UTC(2026, 9, 14, 2, 0, 0);
    const rows = [];
    for (let i = 0; i < 90; i++) {
      const lat = 39.9050 + i * 0.00030 + Math.sin(i / 6) * 0.00025;
      const lon = 116.3900 + i * 0.00022 + Math.cos(i / 5) * 0.00030;
      rows.push('<trkpt lat="' + lat.toFixed(7) + '" lon="' + lon.toFixed(7) + '"><time>' +
        new Date(t0 + i * 8000).toISOString() + '</time></trkpt>');
    }
    return '<?xml version="1.0"?><gpx version="1.1"><trk><name>周末骑行 · 滨江</name><trkseg>' + rows.join('') + '</trkseg></trk></gpx>';
  })()`);
  await evaluate(`(async () => {
    const file = new File([${JSON.stringify(gpx)}], 'demo.gpx', { type: 'application/gpx+xml' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('#fileImport');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    document.querySelector('#tabTracks').click();
  })()`);
  await sleep(4000);
  await shot('preview-track.png');
} finally {
  if (ws) try { ws.close(); } catch (e) {}
  browser.kill();
  server.kill();
}
