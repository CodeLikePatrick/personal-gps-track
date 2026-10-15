/**
 * 核心逻辑测试：node tests/core.test.mjs
 * 直接加载浏览器用的 core.js（无模块系统），避免维护两份代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.join(here, '..', 'core.js');
const sandbox = { console, Date, Math, JSON, isFinite, parseFloat, parseInt };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(corePath, 'utf8'), sandbox, { filename: 'core.js' });
const T = sandbox.TrackCore;

let pass = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}
function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${label || 'value'}: 实际 ${actual}，期望 ${expected} ±${tol}`);
}

/* ---------- 测试数据：正北方向 19 段，每段 0.001° 纬度 = 111.195 m ---------- */
const M_PER_DEG_LAT = 6371008.8 * Math.PI / 180; // 111195.08 m
function straightNorthRide(stepCount = 20, lat0 = 39.9, lon0 = 116.4) {
  const pts = [];
  for (let i = 0; i < stepCount; i++) {
    pts.push({ t: 1700000000000 + i * 12000, lat: lat0 + i * 0.001, lon: lon0, acc: 6, alt: 50 });
  }
  return pts;
}

console.log('\ncore.js');

test('haversine: 1 度纬度 ≈ 111.195 km', () => {
  const d = T.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  near(d, 111195.08, 1, '距离(米)');
  assert.equal(T.haversine({ lat: 39.9, lon: 116.4 }, { lat: 39.9, lon: 116.4 }), 0);
  // 东西向 0.001° 在北京纬度约 85.4 m
  near(T.haversine({ lat: 39.9, lon: 116.4 }, { lat: 39.9, lon: 116.401 }), 85.4, 0.5, '东西向(米)');
});

test('measure: 正常段被接受并给出正确速度', () => {
  const a = { t: 1700000000000, lat: 39.9, lon: 116.4, acc: 5 };
  const b = { t: 1700000012000, lat: 39.901, lon: 116.4, acc: 5 };
  const m = T.measure(a, b, {});
  assert.equal(m.accept, true);
  near(m.distM, M_PER_DEG_LAT / 1000, 0.01, '段长(米)');
  near(m.kmh, 33.36, 0.05, '速度(km/h)');
});

test('measure: 精度差的点被丢弃', () => {
  const a = { t: 1700000000000, lat: 39.9, lon: 116.4, acc: 5 };
  const b = { t: 1700000012000, lat: 39.901, lon: 116.4, acc: 80 };
  const m = T.measure(a, b, {});
  assert.equal(m.accept, false);
  assert.equal(m.reason, 'accuracy');
});

test('measure: 瞬移般的跳变被丢弃', () => {
  const a = { t: 1700000000000, lat: 39.9, lon: 116.4, acc: 5 };
  const b = { t: 1700000001000, lat: 39.95, lon: 116.4, acc: 5 };
  const m = T.measure(a, b, {});
  assert.equal(m.accept, false);
  assert.equal(m.reason, 'speed');
});

test('measure: 静止抖动不计距离但点保留', () => {
  const a = { t: 1700000000000, lat: 39.9, lon: 116.4, acc: 5 };
  const b = { t: 1700000001000, lat: 39.900005, lon: 116.4, acc: 5 };
  const m = T.measure(a, b, {});
  assert.equal(m.accept, true);
  assert.equal(m.reason, 'too-short');
  assert.equal(m.distM, 0);
  assert.ok(m.rawDistM > 0);
});

test('analyze: 直线骑行统计正确', () => {
  const pts = straightNorthRide(20);
  const r = T.analyze(pts);
  near(r.stats.distanceKm, (M_PER_DEG_LAT * 0.019) / 1000, 0.0005, '距离(km)');
  near(r.stats.durationS, 240 - 12, 0.001, '时长(秒)');
  near(r.stats.avgKmh, 33.36, 0.05, '均速');
  near(r.stats.maxKmh, 33.36, 0.2, '最高速度');
  assert.equal(r.stats.keptCount, 20);
  assert.equal(r.stats.rejected, 0);
  assert.equal(r.chunks.length, 1);
  assert.equal(r.segments.length, 19);
  assert.equal(r.stats.speedSeries.length, 19);
});

test('analyze: 每公里自动分段', () => {
  const pts = straightNorthRide(40);   // 39 段 ≈ 4.34 km
  const r = T.analyze(pts);
  assert.equal(r.stats.splits.length, 4, '应切出 4 个整公里点');
  assert.equal(r.stats.splits[0].km, 1);
  assert.equal(r.stats.splits[0].splitS, null, '第一公里没有上一段');
  near(r.stats.splits[1].splitS, 111.195 * 9 / 9.266, 3, '第二公里用时(秒)');
});

test('analyze: 暂停跨过的位移不计入距离', () => {
  const pts = straightNorthRide(10);               // 9 段 = 1000.76 m
  const gapStart = pts[9].lat + 0.002;             // 暂停期间移动了 222 m
  const tail = [
    { t: pts[9].t + 20000, lat: gapStart, lon: 116.4, acc: 6, brk: true },
    { t: pts[9].t + 28000, lat: gapStart + 0.001, lon: 116.4, acc: 6 }
  ];
  const r = T.analyze(pts.concat(tail));
  // 只保留暂停前 1000.76 m + 恢复后那一段 111.20 m；暂停跨过的 222 m 必须被丢掉。
  // 若错误地跨暂停累计，距离会变成 1334 m，所以上限卡在 1.2 km 就能抓出回归。
  near(r.stats.distanceKm, (M_PER_DEG_LAT * 0.010) / 1000, 0.0005, '距离');
  assert.ok(r.stats.distanceKm < 1.2, '暂停跨过的位移不能计入');
  assert.equal(r.chunks.length, 2, '应按断点分成两段');
  assert.equal(r.stats.pointCount, 12);
  assert.equal(r.segments.length, 10, '暂停前 9 段 + 恢复后 1 段');
});

test('analyze: 轨迹类型建议', () => {
  assert.equal(T.suggestActivity({ movingAvgKmh: 4 }), 'walk');
  assert.equal(T.suggestActivity({ movingAvgKmh: 18 }), 'bike');
  assert.equal(T.suggestActivity({ movingAvgKmh: 45 }), 'car');
});

test('GPX: 导出再导入坐标与时间不丢', () => {
  const pts = straightNorthRide(6);
  const r = T.analyze(pts);
  const gpx = T.toGpx({ name: '测试<轨迹>', activity: 'bike', startedAt: pts[0].t, points: r.kept });
  assert.ok(gpx.includes('<gpx version="1.1"'));
  assert.ok(gpx.includes('&lt;轨迹&gt;'), '名称需要转义');
  const back = T.parseGpx(gpx);
  assert.equal(back.points.length, 6);
  assert.equal(back.assumedTime, false);
  near(back.points[3].lat, pts[3].lat, 1e-9, '纬度');
  near(back.points[3].lon, pts[3].lon, 1e-9, '经度');
  assert.equal(back.points[3].t, pts[3].t);
  near(back.points[3].alt, 50, 0.001, '海拔');
});

test('GPX: 兼容自闭合 trkpt 与缺失时间', () => {
  const text = '<gpx><trk><name>外部文件</name><trkseg>' +
    '<trkpt lat="39.9" lon="116.4"/>' +
    '<trkpt lat="39.901" lon="116.4"><ele>12.5</ele></trkpt>' +
    '</trkseg></trk></gpx>';
  const back = T.parseGpx(text);
  assert.equal(back.points.length, 2);
  assert.equal(back.name, '外部文件');
  assert.equal(back.assumedTime, true);
  near(back.points[1].alt, 12.5, 1e-9, '海拔');
});

test('GeoJSON / CSV 导出结构正确', () => {
  const pts = straightNorthRide(4);
  const r = T.analyze(pts);
  const gj = JSON.parse(T.toGeoJson({ name: 't', activity: 'bike', points: r.kept }, r.stats));
  assert.equal(gj.features[0].geometry.type, 'LineString');
  assert.equal(gj.features[0].geometry.coordinates.length, 4);
  assert.equal(gj.features[0].geometry.coordinates[0].length, 2);
  near(gj.features[0].geometry.coordinates[0][0], 116.4, 1e-6, '经度在前');
  near(gj.features[0].properties.distanceKm, r.stats.distanceKm, 1e-9, '统计写入属性');

  const csv = T.toCsv({ startedAt: pts[0].t, points: r.kept });
  const lines = csv.split('\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith('time_iso,elapsed_s,lat,lon'));
  assert.ok(lines[1].endsWith(',0.0,39.9000000,116.4000000,6.0,50.00,,'));
});

test('GeoJSON 导入可用', () => {
  const pts = straightNorthRide(5);
  const r = T.analyze(pts);
  const back = T.parseGeoJson(T.toGeoJson({ name: 'x', points: r.kept }, r.stats));
  assert.equal(back.points.length, 5);
  near(back.points[2].lon, 116.4, 1e-9, '经度');
  near(back.points[2].lat, pts[2].lat, 1e-9, '纬度');
});

test('坐标系: 中国境内有偏移，境外原样返回', () => {
  const wgs = [116.397428, 39.90923];
  const gcj = T.wgs84ToGcj02(wgs[0], wgs[1]);
  const shift = T.haversine({ lat: wgs[1], lon: wgs[0] }, { lat: gcj[1], lon: gcj[0] });
  console.log(`       北京偏移 ${shift.toFixed(1)} m -> ${gcj[0].toFixed(6)}, ${gcj[1].toFixed(6)}`);
  assert.ok(shift > 300 && shift < 900, '偏移量应在几百米量级');
  const tokyo = T.wgs84ToGcj02(139.7671, 35.6812);
  near(tokyo[0], 139.7671, 0, '境外经度应原样返回');
  near(tokyo[1], 35.6812, 0, '境外纬度应原样返回');
  const roundTrip = T.gcj02ToWgs84(gcj[0], gcj[1]);
  near(roundTrip[0], wgs[0], 1e-6, '往返经度');
  near(roundTrip[1], wgs[1], 1e-6, '往返纬度');
});

test('fmtDuration', () => {
  assert.equal(T.fmtDuration(0), '0:00');
  assert.equal(T.fmtDuration(65), '1:05');
  assert.equal(T.fmtDuration(3725), '1:02:05');
});

console.log(`\n${pass} 通过, ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
