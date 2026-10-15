/*!
 * 轨迹记录仪 — 核心逻辑层
 * 纯函数，无 DOM / 无网络依赖：浏览器挂到 window.TrackCore，Node 测试直接加载。
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    maxAccuracyM: 35,     // 定位精度比这个差的点直接丢弃
    maxSpeedKmh: 100,     // 两点的隐含速度超过它视为 GPS 跳变
    minSegmentM: 2,       // 短于此长度的位移不计入距离（防止静止时抖动累积）
    accuracyFactor: 0.3,  // 段长下限还取 accuracy*该系数，精度越差要求走得越远
    smoothWindowSec: 5,   // 即时速度的滑动窗口
    splitKm: 1,           // 每多少公里切一段
    moveSpeedKmh: 1.2     // 高于它才算"在移动"
  };

  var EARTH_R = 6371008.8;
  var DEG = Math.PI / 180;

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function num(v, fallback) {
    return isNum(v) ? v : fallback;
  }

  function haversine(a, b) {
    var dLat = (b.lat - a.lat) * DEG;
    var dLon = (b.lon - a.lon) * DEG;
    var la1 = a.lat * DEG;
    var la2 = b.lat * DEG;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** 把浏览器的 GeolocationPosition 转成内部点结构。 */
  function fromGeolocation(pos) {
    var c = pos && pos.coords ? pos.coords : {};
    return {
      t: num(pos && pos.timestamp, Date.now()),
      lat: c.latitude,
      lon: c.longitude,
      acc: isNum(c.accuracy) ? c.accuracy : null,
      alt: isNum(c.altitude) ? c.altitude : null,
      hdg: isNum(c.heading) ? c.heading : null,
      spd: isNum(c.speed) && c.speed >= 0 ? c.speed : null
    };
  }

  function validPoint(p) {
    return !!p && isNum(p.lat) && isNum(p.lon) && isNum(p.t) &&
      p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
  }

  /** 判断 prev -> cur 这一段能不能收下，以及它贡献多少距离。 */
  function measure(prev, cur, opts) {
    var o = assign({}, DEFAULTS, opts || {});
    var dt = (cur.t - prev.t) / 1000;
    var dist = haversine(prev, cur);
    if (!(dt > 0)) {
      return { accept: false, reason: 'time', distM: dist, rawDistM: dist, dtS: 0, kmh: 0 };
    }
    var kmh = dist / dt * 3.6;
    if (isNum(cur.acc) && cur.acc > o.maxAccuracyM) {
      return { accept: false, reason: 'accuracy', distM: dist, rawDistM: dist, dtS: dt, kmh: kmh };
    }
    if (kmh > o.maxSpeedKmh) {
      return { accept: false, reason: 'speed', distM: dist, rawDistM: dist, dtS: dt, kmh: kmh };
    }
    var accWorst = Math.max(num(prev.acc, 0), num(cur.acc, 0));
    var minDist = Math.max(o.minSegmentM, accWorst * o.accuracyFactor);
    return {
      accept: true,
      reason: dist < minDist ? 'too-short' : 'ok',
      distM: dist < minDist ? 0 : dist,
      rawDistM: dist,
      dtS: dt,
      kmh: kmh
    };
  }

  /** 时间窗口内的平均速度（滑动，时间轴对齐）。 */
  function smoothedSpeeds(segs, windowSec) {
    var out = [];
    var head = 0;
    var sumD = 0;
    var sumT = 0;
    for (var i = 0; i < segs.length; i++) {
      sumD += segs[i].distM;
      sumT += segs[i].dtS;
      while (segs[head].t < segs[i].t - windowSec * 1000) {
        sumD -= segs[head].distM;
        sumT -= segs[head].dtS;
        head++;
      }
      var v = sumT > 0 ? (sumD / sumT) * 3.6 : 0;
      out.push({ t: segs[i].t, kmh: v, distKm: 0 });
    }
    return out;
  }

  /** 每 splitKm 一段的用时。 */
  function computeSplits(segs, splitKm) {
    var step = splitKm * 1000;
    var splits = [];
    var cum = 0;
    var target = step;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.distM <= 0) continue;
      var from = cum;
      var to = cum + s.distM;
      while (to >= target) {
        var ratio = (target - from) / (to - from);
        var crossT = s.t - s.dtS * 1000 * (1 - ratio);
        splits.push({ km: Math.round(target / step), endT: crossT });
        target += step;
      }
      cum = to;
    }
    for (var j = 0; j < splits.length; j++) {
      var prevT = j === 0 ? null : splits[j - 1].endT;
      splits[j].splitS = prevT === null ? null : (splits[j].endT - prevT) / 1000;
    }
    return splits;
  }

  function computeElevation(pts) {
    var withAlt = pts.filter(function (p) { return isNum(p.alt); });
    if (withAlt.length < pts.length * 0.5 || withAlt.length < 5) {
      return { ascentM: null, descentM: null, reliable: false };
    }
    var ascent = 0;
    var descent = 0;
    var last = withAlt[0].alt;
    for (var i = 1; i < withAlt.length; i++) {
      var d = withAlt[i].alt - last;
      if (Math.abs(d) < 3) continue;   // 手机气压/GPS 高程噪声大，小于 3 米的变化忽略
      if (d > 0) ascent += d; else descent -= d;
      last = withAlt[i].alt;
    }
    return { ascentM: ascent, descentM: descent, reliable: true };
  }

  /** 主入口：清洗 -> 分段 -> 统计。 */
  function analyze(points, options) {
    var o = assign({}, DEFAULTS, options || {});
    var all = (points || []).filter(validPoint).slice().sort(function (a, b) { return a.t - b.t; });

    var kept = [];
    var segs = [];
    var rejectCount = { accuracy: 0, speed: 0, time: 0 };

    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      if (p.brk) {                        // 暂停后的第一个点：只当锚点，不跨暂停算距离
        if (isNum(p.acc) && p.acc > o.maxAccuracyM) { rejectCount.accuracy++; continue; }
        kept.push(p);
        continue;
      }
      if (!kept.length) {
        if (isNum(p.acc) && p.acc > o.maxAccuracyM) { rejectCount.accuracy++; continue; }
        kept.push(p);
        continue;
      }
      var prev = kept[kept.length - 1];
      // prev 是 brk 点时，它正好充当暂停后的新锚点，照常测量
      var m = measure(prev, p, o);
      if (!m.accept) {
        rejectCount[m.reason] = (rejectCount[m.reason] || 0) + 1;
        continue;
      }
      kept.push(p);
      segs.push({
        t: p.t,
        t0: prev.t,
        distM: m.distM,
        rawDistM: m.rawDistM,
        dtS: m.dtS,
        kmh: m.kmh,
        tooShort: m.reason === 'too-short'
      });
    }

    var chunks = [];
    kept.forEach(function (p) {
      if (p.brk || !chunks.length) chunks.push([]);
      chunks[chunks.length - 1].push(p);
    });

    var startTime = kept.length ? kept[0].t : null;
    var endTime = kept.length ? kept[kept.length - 1].t : null;
    var pausedMs = num(o.pausedMs, 0);
    var durationS = startTime && endTime ? Math.max(0, (endTime - startTime - pausedMs) / 1000) : 0;
    var distanceM = segs.reduce(function (a, s) { return a + s.distM; }, 0);
    var movingS = segs.reduce(function (a, s) { return a + (s.kmh >= o.moveSpeedKmh ? s.dtS : 0); }, 0);
    var series = smoothedSpeeds(segs, o.smoothWindowSec);
    var maxKmh = series.reduce(function (a, s) { return Math.max(a, s.kmh); }, 0);
    var maxRawKmh = segs.reduce(function (a, s) { return Math.max(a, s.kmh); }, 0);
    var elevation = computeElevation(kept);

    var stats = {
      pointCount: all.length,
      keptCount: kept.length,
      rejected: rejectCount.accuracy + rejectCount.speed + rejectCount.time,
      rejectDetail: rejectCount,
      startTime: startTime,
      endTime: endTime,
      durationS: durationS,
      movingS: movingS,
      pausedMs: pausedMs,
      distanceKm: distanceM / 1000,
      avgKmh: durationS > 0 ? (distanceM / 1000) / (durationS / 3600) : 0,
      movingAvgKmh: movingS > 0 ? (distanceM / 1000) / (movingS / 3600) : 0,
      maxKmh: maxKmh,
      maxRawKmh: maxRawKmh,
      ascentM: elevation.ascentM,
      descentM: elevation.descentM,
      elevationReliable: elevation.reliable
    };
    stats.splits = computeSplits(segs, o.splitKm);
    stats.speedSeries = series.map(function (s) {
      return { t: (s.t - (startTime || s.t)) / 1000, kmh: s.kmh };
    });
    return { points: all, kept: kept, chunks: chunks, segments: segs, stats: stats };
  }

  /** 依据速度分布给一个轨迹类型建议（仅作默认值）。 */
  function suggestActivity(stats) {
    var v = stats && stats.movingAvgKmh ? stats.movingAvgKmh : (stats ? stats.avgKmh : 0);
    if (!v) return 'bike';
    if (v < 8) return 'walk';
    if (v < 26) return 'bike';
    return 'car';
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(num(sec, 0)));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  /* ---------- 坐标系：高德/腾讯瓦片是 GCJ-02，浏览器 GPS 是 WGS-84 ---------- */

  var GCJ_A = 6378245.0;
  var GCJ_EE = 0.00669342162296594323;

  function outOfChina(lon, lat) {
    return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function transformLat(x, y) {
    var r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return r;
  }

  function transformLon(x, y) {
    var r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return r;
  }

  function wgs84ToGcj02(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];
    var dLat = transformLat(lon - 105.0, lat - 35.0);
    var dLon = transformLon(lon - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * Math.PI;
    var magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLon = (dLon * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lon + dLon, lat + dLat];
  }

  function gcj02ToWgs84(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];
    var g = wgs84ToGcj02(lon, lat);
    return [lon * 2 - g[0], lat * 2 - g[1]];
  }

  /* ---------- 导出 ---------- */

  var ACTIVITY_LABEL = { bike: '骑行', car: '开车', walk: '步行', run: '跑步' };
  var ACTIVITY_GPX = { bike: 'cycling', car: 'driving', walk: 'walking', run: 'running' };

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function isoTime(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) + 'T' +
      pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + '.' +
      pad(d.getUTCMilliseconds(), 3) + 'Z';
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
    });
  }

  /** track: {name, activity, points(已清洗), startedAt}（坐标一律 WGS-84） */
  function toGpx(track) {
    var pts = track.points || [];
    var lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<gpx version="1.1" creator="track-recorder" xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">');
    lines.push('  <metadata>');
    lines.push('    <name>' + escapeXml(track.name || 'track') + '</name>');
    if (track.startedAt) lines.push('    <time>' + isoTime(track.startedAt) + '</time>');
    lines.push('  </metadata>');
    lines.push('  <trk>');
    lines.push('    <name>' + escapeXml(track.name || 'track') + '</name>');
    lines.push('    <type>' + (ACTIVITY_GPX[track.activity] || 'cycling') + '</type>');
    lines.push('    <trkseg>');
    pts.forEach(function (p) {
      lines.push('      <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '">' +
        (isNum(p.alt) ? '<ele>' + p.alt.toFixed(2) + '</ele>' : '') +
        '<time>' + isoTime(p.t) + '</time>' +
        '</trkpt>');
    });
    lines.push('    </trkseg>');
    lines.push('  </trk>');
    lines.push('</gpx>');
    return lines.join('\n');
  }

  function toGeoJson(track, stats) {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          name: track.name || 'track',
          activity: track.activity || 'bike',
          startedAt: track.startedAt ? isoTime(track.startedAt) : null,
          durationS: stats ? stats.durationS : null,
          distanceKm: stats ? stats.distanceKm : null,
          avgKmh: stats ? stats.avgKmh : null,
          maxKmh: stats ? stats.maxKmh : null,
          crs: 'WGS-84'
        },
        geometry: {
          type: 'LineString',
          coordinates: (track.points || []).map(function (p) {
            return [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))];
          })
        }
      }]
    }, null, 2);
  }

  function toCsv(track) {
    var rows = ['time_iso,elapsed_s,lat,lon,accuracy_m,altitude_m,gps_speed_kmh,heading_deg'];
    var t0 = track.startedAt || (track.points && track.points[0] ? track.points[0].t : 0);
    (track.points || []).forEach(function (p) {
      rows.push([
        isoTime(p.t),
        ((p.t - t0) / 1000).toFixed(1),
        p.lat.toFixed(7),
        p.lon.toFixed(7),
        isNum(p.acc) ? p.acc.toFixed(1) : '',
        isNum(p.alt) ? p.alt.toFixed(2) : '',
        isNum(p.spd) ? (p.spd * 3.6).toFixed(2) : '',
        isNum(p.hdg) ? p.hdg.toFixed(1) : ''
      ].join(','));
    });
    return rows.join('\n');
  }

  /** 容错优先的 GPX 解析：只认 trkpt，兼容常见的第三方导出文件。 */
  function parseGpx(text) {
    var trkName = /<trk>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text);
    var name = trkName ? trkName[1].trim() : '';
    var pts = [];
    var re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var attrs = m[1] || '';
      var body = m[2] || '';
      var lat = /\blat\s*=\s*"([-\d.eE+]+)"/.exec(attrs);
      var lon = /\blon\s*=\s*"([-\d.eE+]+)"/.exec(attrs);
      if (!lat || !lon) continue;
      var ele = /<ele>\s*([-\d.]+)\s*<\/ele>/.exec(body);
      var time = /<time>\s*([^<\s]+)\s*<\/time>/.exec(body);
      pts.push({
        t: time ? Date.parse(time[1]) : null,
        lat: parseFloat(lat[1]),
        lon: parseFloat(lon[1]),
        alt: ele ? parseFloat(ele[1]) : null,
        acc: null,
        spd: null,
        hdg: null
      });
    }
    var missingTime = pts.some(function (p) { return !isNum(p.t); });
    if (missingTime) {
      var base = Date.now();
      pts.forEach(function (p, i) { if (!isNum(p.t)) p.t = base + i * 1000; });
    }
    return { name: name, points: pts, assumedTime: missingTime };
  }

  function parseGeoJson(text) {
    var data = JSON.parse(text);
    var feats = data.type === 'FeatureCollection' ? data.features : [data];
    var pts = [];
    var name = '';
    feats.forEach(function (f) {
      if (!f || !f.geometry) return;
      if (f.properties && f.properties.name) name = f.properties.name;
      var coords = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
      var base = Date.now();
      (coords || []).forEach(function (line) {
        (line || []).forEach(function (c, i) {
          if (!c || c.length < 2) return;
          pts.push({ t: base + i * 1000, lat: c[1], lon: c[0], alt: c.length > 2 ? c[2] : null, acc: null, spd: null, hdg: null });
        });
      });
    });
    return { name: name, points: pts, assumedTime: true };
  }

  root.TrackCore = {
    DEFAULTS: DEFAULTS,
    ACTIVITY_LABEL: ACTIVITY_LABEL,
    assign: assign,
    num: num,
    isNum: isNum,
    haversine: haversine,
    fromGeolocation: fromGeolocation,
    validPoint: validPoint,
    measure: measure,
    analyze: analyze,
    suggestActivity: suggestActivity,
    computeSplits: computeSplits,
    fmtDuration: fmtDuration,
    wgs84ToGcj02: wgs84ToGcj02,
    gcj02ToWgs84: gcj02ToWgs84,
    toGpx: toGpx,
    toGeoJson: toGeoJson,
    toCsv: toCsv,
    parseGpx: parseGpx,
    parseGeoJson: parseGeoJson,
    isoTime: isoTime
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
