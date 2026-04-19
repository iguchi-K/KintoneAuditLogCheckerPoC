// =====================================================================
// Worker ソースコード (Blob URL として使用)
// =====================================================================
const WORKER_SRC = `
'use strict';

var allRows = [];
var headers = [];

function parseCSV(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  var n = text.length;

  while (i < n) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"'; i += 2;
        } else {
          inQuotes = false; i++;
        }
      } else {
        field += c; i++;
      }
    } else {
      if (c === '"') {
        inQuotes = true; i++;
      } else if (c === ',') {
        row.push(field); field = ''; i++;
      } else if (c === '\\r') {
        i++;
      } else if (c === '\\n') {
        row.push(field); field = '';
        if (row.length > 0) rows.push(row);
        row = []; i++;
      } else {
        field += c; i++;
      }
    }
  }
  row.push(field);
  if (row.some(function(f){ return f.trim() !== ''; })) rows.push(row);
  return rows;
}

function isWeekend(dateStr) {
  var parts = dateStr.split(/[\/\-]/);
  if (parts.length < 3) return false;
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  var day = d.getDay();
  return day === 0 || day === 6;
}

function applyFilters(filters) {
  var result = allRows;

  // クイックフィルター
  if (filters.quickWeekend) {
    result = result.filter(function(r) {
      if (!r[0]) return false;
      var dateStr = r[0].split(' ')[0];
      var action = (r[6] || '').toLowerCase();
      return action === 'login' && isWeekend(dateStr);
    });
  }
  if (filters.quickFailedLogin) {
    result = result.filter(function(r) {
      return (r[6] || '').toLowerCase() === 'login' && (r[7] || '') === 'FAILED';
    });
  }
  if (filters.quickDownload) {
    result = result.filter(function(r) {
      return (r[6] || '').toLowerCase().includes('download');
    });
  }
  // 時間フィルター (値は "18時" 形式)
  if (filters.hours && filters.hours.length > 0) {
    var hourSet = new Set(filters.hours);
    result = result.filter(function(r) {
      if (!r[0]) return false;
      var timePart = r[0].split(' ')[1] || '';
      var h = parseInt(timePart.split(':')[0], 10);
      return isNaN(h) ? false : hourSet.has(String(h) + '時');
    });
  }

  // 日付フィルター (YYYY/M/D 単位、秒は無視)
  if (filters.dates && filters.dates.length > 0) {
    var dateSet = new Set(filters.dates);
    result = result.filter(function(r) {
      if (!r[0]) return false;
      return dateSet.has(r[0].split(' ')[0]);
    });
  }

  // CIDRフィルター (マスク可変)
  if (filters.cidrs && filters.cidrs.length > 0) {
    var cidrSet = new Set(filters.cidrs);
    var cidrMask = filters.cidrMask || 24;
    var cidrOctets = cidrMask === 8 ? 1 : cidrMask === 16 ? 2 : 3;
    result = result.filter(function(r) {
      var ip = r[2] || '';
      var pts = ip.split('.');
      if (pts.length !== 4) return false;
      var zeros = [];
      for (var z = cidrOctets; z < 4; z++) zeros.push('0');
      var prefix = pts.slice(0, cidrOctets).concat(zeros).join('.') + '/' + cidrMask;
      return cidrSet.has(prefix);
    });
  }

  // 国フィルター
  if (filters.countries && filters.countries.length > 0) {
    var countrySet = new Set(filters.countries);
    var ipMap = filters.ipCountryMap || {};
    result = result.filter(function(r) {
      return countrySet.has(ipMap[r[2] || ''] || '不明');
    });
  }

  // 列フィルター
  var colFilters = filters.columns || {};
  var colKeys = Object.keys(colFilters);
  for (var k = 0; k < colKeys.length; k++) {
    var idx = parseInt(colKeys[k], 10);
    var vals = colFilters[colKeys[k]];
    if (!vals || vals.length === 0) continue;
    var valSet = new Set(vals);
    result = result.filter(function(r) { return valSet.has(r[idx] || ''); });
  }

  return result;
}

function buildChartData(rows) {
  var counts = {};
  rows.forEach(function(r) {
    if (!r[0] || !r[0].trim()) return;
    var date = r[0].split(' ')[0];
    var parts = date.split('/');
    if (parts.length < 3) return;
    // YYYY/M/D 形式か確認
    if (isNaN(parseInt(parts[0], 10)) || isNaN(parseInt(parts[1], 10)) || isNaN(parseInt(parts[2], 10))) return;
    counts[date] = (counts[date] || 0) + 1;
  });
  var entries = Object.keys(counts).map(function(k) { return [k, counts[k]]; });
  entries.sort(function(a, b) {
    var da = a[0].split('/').map(function(s){ return parseInt(s, 10); });
    var db = b[0].split('/').map(function(s){ return parseInt(s, 10); });
    for (var i = 0; i < 3; i++) {
      if (da[i] !== db[i]) return da[i] - db[i];
    }
    return 0;
  });
  return entries;
}

self.onmessage = function(e) {
  var msg = e.data;

  if (msg.type === 'parse') {
    try {
      var text = new TextDecoder(msg.encoding || 'utf-8').decode(new Uint8Array(msg.buffer));
      var parsed = parseCSV(text);
      if (parsed.length < 2) {
        self.postMessage({ type: 'error', message: 'データが見つかりません' });
        return;
      }
      headers = parsed[0];
      allRows = parsed.slice(1).filter(function(r) {
        return r.some(function(f) { return f.trim() !== ''; });
      });

      // 各列のユニーク値 (出現回数付き)
      var uniqueValues = {};
      for (var i = 1; i < headers.length; i++) {
        var map = new Map();
        allRows.forEach(function(r) {
          var v = r[i] !== undefined ? r[i] : '';
          map.set(v, (map.get(v) || 0) + 1);
        });
        var arr = Array.from(map.entries());
        arr.sort(function(a, b) { return b[1] - a[1]; });
        uniqueValues[i] = arr;
      }

      // 日付ユニーク値
      var dateMap = new Map();
      allRows.forEach(function(r) {
        if (r[0]) {
          var d = r[0].split(' ')[0];
          dateMap.set(d, (dateMap.get(d) || 0) + 1);
        }
      });
      var uniqueDates = Array.from(dateMap.entries());
      uniqueDates.sort(function(a, b) {
        var da = a[0].split('/').map(Number);
        var db = b[0].split('/').map(Number);
        for (var i = 0; i < 3; i++) {
          if (da[i] !== db[i]) return da[i] - db[i];
        }
        return 0;
      });

      // 時間ユニーク値
      var hourMap = new Map();
      allRows.forEach(function(r) {
        if (r[0]) {
          var timePart = r[0].split(' ')[1] || '';
          var h = parseInt(timePart.split(':')[0], 10);
          if (!isNaN(h)) {
            var hStr = String(h);
            hourMap.set(hStr, (hourMap.get(hStr) || 0) + 1);
          }
        }
      });
      var uniqueHours = Array.from(hourMap.entries());
      uniqueHours.sort(function(a, b) { return parseInt(a[0], 10) - parseInt(b[0], 10); });

      // CIDR /24 ユニーク値
      var cidrMap = new Map();
      allRows.forEach(function(r) {
        var ip = r[2] || '';
        if (!ip) return;
        var pts = ip.split('.');
        if (pts.length !== 4) return;
        var cidr = pts[0]+'.'+pts[1]+'.'+pts[2]+'.0/24';
        cidrMap.set(cidr, (cidrMap.get(cidr) || 0) + 1);
      });
      var uniqueCidrs = Array.from(cidrMap.entries());
      uniqueCidrs.sort(function(a,b){ return a[0].localeCompare(b[0]); });

      // ユニークIPリスト (国取得用)
      var ipSet = new Set();
      allRows.forEach(function(r){ if (r[2]) ipSet.add(r[2]); });

      self.postMessage({
        type: 'parsed',
        headers: headers,
        totalRows: allRows.length,
        uniqueValues: uniqueValues,
        uniqueDates: uniqueDates,
        uniqueHours: uniqueHours,
        uniqueCidrs: uniqueCidrs,
        uniqueIPs: Array.from(ipSet)
      });
    } catch(err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }

  else if (msg.type === 'filter') {
    try {
      var filtered = applyFilters(msg.filters);
      self.postMessage({
        type: 'filtered',
        rows: filtered,
        matchCount: filtered.length
      });
    } catch(err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
`;

// =====================================================================
// Worker 初期化
// =====================================================================
const workerBlob = new Blob([WORKER_SRC], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(workerBlob));

// =====================================================================
// アプリ状態
// =====================================================================
const PAGE_SIZE = 200;

const state = {
  loaded: false,
  totalRows: 0,
  headers: [],
  uniqueValues: {},
  uniqueDates: [],
  uniqueHours: [],
  uniqueCidrs: [],
  uniqueIPs: [],
  ipCountryMap: {},
  uniqueCountries: [],
  currentRows: [],
  currentPage: 0,
  cidrMask: 24,
  filters: {
    quickWeekend:     false,
    quickFailedLogin: false,
    quickDownload:    false,
    dates:     [],
    hours:     [],
    cidrs:     [],
    countries: [],
    columns:   {}
  }
};

// =====================================================================
// チャートデータ集計 (メインスレッド)
// =====================================================================
function buildChartData(rows) {
  const counts = {};
  rows.forEach(r => {
    const dateField = r[0];
    if (!dateField) return;
    const date = String(dateField).split(' ')[0];
    counts[date] = (counts[date] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => {
    const da = a[0].split('/').map(Number);
    const db = b[0].split('/').map(Number);
    for (let i = 0; i < 3; i++) {
      if (da[i] !== db[i]) return (da[i] || 0) - (db[i] || 0);
    }
    return 0;
  });
}

// =====================================================================
// Worker メッセージ処理
// =====================================================================
worker.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'error') {
    hideLoading();
    alert('エラー: ' + msg.message);
  }
  else if (msg.type === 'parsed') {
    state.loaded      = true;
    state.totalRows   = msg.totalRows;
    state.headers     = msg.headers;
    state.uniqueValues   = msg.uniqueValues;
    state.uniqueDates    = msg.uniqueDates;
    state.uniqueHours    = msg.uniqueHours    || [];
    state.uniqueCidrs    = msg.uniqueCidrs    || [];
    state.uniqueIPs      = msg.uniqueIPs      || [];
    hideLoading();
    applyLocalCountryLookup();
    buildTableHeader();
    buildFilterUI();
    resetFiltersOnly();
    triggerFilter();
  }
  else if (msg.type === 'filtered') {
    state.currentRows = msg.rows;
    state.currentPage = 0;
    renderTable();
    updateStatus();
    hideRightOverlay();
  }
};

worker.onerror = function(e) {
  hideLoading();
  alert('Worker エラー: ' + e.message);
};

// =====================================================================
// ファイル読み込み
// =====================================================================
document.getElementById('open-btn').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const encoding = document.getElementById('encoding-select').value;
  showLoading('CSVを読み込み中...');
  const reader = new FileReader();
  reader.onload = ev => {
    // ArrayBuffer を転送 (コピーなし)
    worker.postMessage({ type: 'parse', buffer: ev.target.result, encoding }, [ev.target.result]);
  };
  reader.readAsArrayBuffer(file);
  this.value = '';
});

// =====================================================================
// テーブルヘッダー構築
// =====================================================================
const COL_DEFAULT_WIDTHS = [140, 190, 110, 80, 130, 80, 160, 70, 80, 280];
const COLLAPSED_WIDTH = 22;
const colSavedWidths = {};
const collapsedCols = new Set();

// td を強制的に折り畳む動的スタイルシート
const colCollapseStyle = document.createElement('style');
document.head.appendChild(colCollapseStyle);

function updateCollapseStyles() {
  colCollapseStyle.textContent = [...collapsedCols].map(i =>
    `#log-table td:nth-child(${i + 1}){max-width:${COLLAPSED_WIDTH}px!important;padding:0!important;overflow:hidden!important;}`
  ).join('');
}

function buildTableHeader() {
  const table = document.getElementById('log-table');
  const tr    = document.getElementById('table-header');
  tr.innerHTML = '';

  // 新CSV読み込み時に折り畳み状態をリセット
  collapsedCols.clear();
  updateCollapseStyles();

  // colgroup で列幅を管理 (th/td 両方に反映される)
  let colgroup = table.querySelector('colgroup');
  if (!colgroup) {
    colgroup = document.createElement('colgroup');
    table.prepend(colgroup);
  }
  colgroup.innerHTML = '';

  state.headers.forEach((h, i) => {
    // col 要素が列幅の唯一の真実
    const col = document.createElement('col');
    col.style.width = (COL_DEFAULT_WIDTHS[i] || 120) + 'px';
    colgroup.appendChild(col);

    const th = document.createElement('th');

    const inner = document.createElement('div');
    inner.className = 'th-inner';

    const label = document.createElement('span');
    label.className = 'col-label';
    label.textContent = h;
    inner.appendChild(label);

    // 折り畳みボタン
    const colBtn = document.createElement('button');
    colBtn.className = 'col-collapse-btn';
    colBtn.title = '列を折り畳む';
    colBtn.textContent = '«';
    colBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (th.classList.contains('col-collapsed')) {
        th.classList.remove('col-collapsed');
        col.style.width = (colSavedWidths[i] || COL_DEFAULT_WIDTHS[i] || 120) + 'px';
        collapsedCols.delete(i);
        colBtn.textContent = '«';
        colBtn.title = '列を折り畳む';
      } else {
        colSavedWidths[i] = parseInt(col.style.width) || th.offsetWidth;
        th.classList.add('col-collapsed');
        col.style.width = COLLAPSED_WIDTH + 'px';
        collapsedCols.add(i);
        colBtn.textContent = '»';
        colBtn.title = '列を展開する';
      }
      updateCollapseStyles();
    });
    inner.appendChild(colBtn);
    th.appendChild(inner);

    // リサイズハンドル
    const resizer = document.createElement('span');
    resizer.className = 'col-resizer';
    th.appendChild(resizer);

    resizer.addEventListener('mousedown', e => {
      if (th.classList.contains('col-collapsed')) return;
      let startX = e.clientX;
      let startW = parseInt(col.style.width) || th.offsetWidth;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = ev => {
        col.style.width = Math.max(40, startW + ev.clientX - startX) + 'px';
      };
      const onUp = () => {
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.stopPropagation();
      e.preventDefault();
    });

    tr.appendChild(th);
  });
}

// =====================================================================
// フィルター UI 構築
// =====================================================================
const COL_LABELS = {
  1: 'ユーザー名',
  2: 'IPアドレス',
  3: 'サービス',
  4: 'アプリケーション',
  5: '重要度 (Severity)',
  6: 'アクション (Action)',
  7: '結果 (Result)',
  8: 'エラーコード',
  9: 'ノート (Note)'
};

function buildFilterUI() {
  const container = document.getElementById('filters-container');
  container.innerHTML = '';

  // 日付フィルター
  container.appendChild(buildSection('日付 (Date)', 'date', state.uniqueDates));

  // 時間フィルター (値は "18時" 形式で保存)
  const hourValues = state.uniqueHours.map(([h, cnt]) => [h + '時', cnt]);
  if (hourValues.length > 0) {
    container.appendChild(buildSection('時間 (Hour)', 'hour', hourValues));
  }

  // CIDRフィルター
  if ((state.uniqueValues[2] || []).length > 0) {
    container.appendChild(buildCidrSection());
  }

  // 国フィルター
  container.appendChild(buildCountrySection());

  // 各列フィルター
  for (let i = 1; i < state.headers.length; i++) {
    const label = COL_LABELS[i] || state.headers[i];
    const values = state.uniqueValues[i] || [];
    container.appendChild(buildSection(label, 'col-' + i, values));
  }
}

function computeUniqueCidrs(mask) {
  const octets = mask === 8 ? 1 : mask === 16 ? 2 : 3;
  const map = {};
  (state.uniqueValues[2] || []).forEach(([ip, cnt]) => {
    if (!ip) return;
    const pts = ip.split('.');
    if (pts.length !== 4) return;
    const zeros = new Array(4 - octets).fill('0');
    const cidr = [...pts.slice(0, octets), ...zeros].join('.') + '/' + mask;
    map[cidr] = (map[cidr] || 0) + cnt;
  });
  return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
}

function buildCidrSection() {
  const sec = document.createElement('div');
  sec.className = 'filter-section';
  sec.id = 'fsec-cidr';

  const hdr = document.createElement('div');
  hdr.className = 'filter-header';
  hdr.innerHTML =
    '<span class="filter-title">CIDR</span>' +
    '<span class="filter-badge" id="badge-cidr">0</span>' +
    '<span class="filter-chevron">▼</span>';
  hdr.addEventListener('click', () => sec.classList.toggle('open'));
  sec.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'filter-body';

  // マスク切り替えトグル
  const maskRow = document.createElement('div');
  maskRow.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';
  [8, 16, 24].forEach(m => {
    const btn = document.createElement('button');
    btn.textContent = '/' + m;
    btn.dataset.mask = m;
    btn.className = 'cidr-mask-btn' + (m === state.cidrMask ? ' active' : '');
    btn.style.cssText = 'flex:1;padding:2px 0;border:1px solid #dde3ea;border-radius:3px;font-size:11px;cursor:pointer;background:white;color:#444;transition:background 0.1s,color 0.1s;';
    if (m === state.cidrMask) {
      btn.style.background = '#1557b0';
      btn.style.color = 'white';
      btn.style.borderColor = '#1557b0';
    }
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (state.cidrMask === m) return;
      state.cidrMask = m;
      state.filters.cidrs = [];
      // ボタン色を更新
      maskRow.querySelectorAll('.cidr-mask-btn').forEach(b => {
        const active = +b.dataset.mask === m;
        b.style.background = active ? '#1557b0' : 'white';
        b.style.color = active ? 'white' : '#444';
        b.style.borderColor = active ? '#1557b0' : '#dde3ea';
      });
      renderCidrItems(itemsDiv);
      const badge = document.getElementById('badge-cidr');
      if (badge) badge.classList.remove('show');
      triggerFilter();
    });
    maskRow.appendChild(btn);
  });
  body.appendChild(maskRow);

  // 全選択/解除
  const acts = document.createElement('div');
  acts.className = 'filter-actions';
  acts.innerHTML =
    '<button class="link-btn" data-all="1">すべて選択</button>' +
    '<button class="link-btn" data-all="0">すべて解除</button>';
  acts.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const checked = btn.dataset.all === '1';
      itemsDiv.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = checked; });
      onFilterChange('cidr');
    });
  });
  body.appendChild(acts);

  const itemsDiv = document.createElement('div');
  itemsDiv.className = 'filter-items';
  itemsDiv.id = 'fitems-cidr';
  renderCidrItems(itemsDiv);
  body.appendChild(itemsDiv);

  sec.appendChild(body);
  return sec;
}

function renderCidrItems(container) {
  container.innerHTML = '';
  const cidrs = computeUniqueCidrs(state.cidrMask);
  cidrs.forEach(([cidr, cnt]) => {
    const id = 'cb-cidr-' + Math.random().toString(36).slice(2, 8);
    const item = document.createElement('div');
    item.className = 'filter-item';
    const isChecked = state.filters.cidrs.includes(cidr);
    item.innerHTML =
      '<input type="checkbox" id="' + id + '" data-key="cidr" data-val="' + escAttr(cidr) + '"' + (isChecked ? ' checked' : '') + '>' +
      '<label for="' + id + '">' + escHtml(cidr) + '</label>' +
      '<span class="fi-count">' + cnt + '</span>';
    item.querySelector('input').addEventListener('change', () => onFilterChange('cidr'));
    container.appendChild(item);
  });
}

function buildCountrySection() {
  const sec = document.createElement('div');
  sec.className = 'filter-section';
  sec.id = 'fsec-country';

  const hdr = document.createElement('div');
  hdr.className = 'filter-header';
  hdr.innerHTML =
    '<span class="filter-title">国 (Country)</span>' +
    '<span class="filter-badge" id="badge-country">0</span>' +
    '<span class="filter-chevron">▼</span>';
  hdr.addEventListener('click', () => sec.classList.toggle('open'));
  sec.appendChild(hdr);

  const body = document.createElement('div');
  body.className = 'filter-body';
  body.id = 'country-filter-body';
  renderCountryBody(body);
  sec.appendChild(body);
  return sec;
}

function renderCountryBody(body) {
  body.innerHTML = '';
  if (state.uniqueCountries.length === 0) {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:11px;color:#aaa;text-align:center;padding:8px;';
    note.textContent = 'IPデータなし';
    body.appendChild(note);
  } else {
    // 全選択/解除
    const acts = document.createElement('div');
    acts.className = 'filter-actions';
    acts.innerHTML =
      '<button class="link-btn" data-all="1">すべて選択</button>' +
      '<button class="link-btn" data-all="0">すべて解除</button>';
    acts.querySelectorAll('.link-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const checked = btn.dataset.all === '1';
        document.querySelectorAll('#fitems-country input[type=checkbox]').forEach(cb => { cb.checked = checked; });
        onFilterChange('country');
      });
    });
    body.appendChild(acts);

    const items = document.createElement('div');
    items.className = 'filter-items';
    items.id = 'fitems-country';
    state.uniqueCountries.forEach(([country, cnt]) => {
      const id = 'cb-country-' + Math.random().toString(36).slice(2, 8);
      const item = document.createElement('div');
      item.className = 'filter-item';
      item.innerHTML =
        '<input type="checkbox" id="' + id + '" data-key="country" data-val="' + escAttr(country) + '">' +
        '<label for="' + id + '">' + escHtml(country) + '</label>' +
        '<span class="fi-count">' + cnt + '</span>';
      item.querySelector('input').addEventListener('change', () => onFilterChange('country'));
      items.appendChild(item);
    });
    body.appendChild(items);
  }
}

function applyLocalCountryLookup() {
  if (typeof window.ip2country !== 'function') return;
  const map = {};
  state.uniqueIPs.forEach(ip => {
    if (ip) map[ip] = window.ip2country(ip);
  });
  state.ipCountryMap = map;

  const counts = {};
  (state.uniqueValues[2] || []).forEach(([ip, cnt]) => {
    const c = map[ip] || '不明';
    counts[c] = (counts[c] || 0) + cnt;
  });
  state.uniqueCountries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function buildSection(title, key, values) {
  const sec = document.createElement('div');
  sec.className = 'filter-section';
  sec.id = 'fsec-' + key;

  // ヘッダー
  const hdr = document.createElement('div');
  hdr.className = 'filter-header';
  hdr.innerHTML =
    '<span class="filter-title">' + escHtml(title) + '</span>' +
    '<span class="filter-badge" id="badge-' + key + '">0</span>' +
    '<span class="filter-chevron">▼</span>';
  hdr.addEventListener('click', () => sec.classList.toggle('open'));
  sec.appendChild(hdr);

  // ボディ
  const body = document.createElement('div');
  body.className = 'filter-body';

  // 検索ボックス (10件超)
  if (values.length > 10) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '絞り込み...';
    inp.className = 'filter-search';
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase();
      document.querySelectorAll('#fitems-' + key + ' .filter-item').forEach(el => {
        el.style.display = el.querySelector('label').textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    body.appendChild(inp);
  }

  // 全選択/解除
  const acts = document.createElement('div');
  acts.className = 'filter-actions';
  acts.innerHTML =
    '<button class="link-btn" data-key="' + key + '" data-all="1">すべて選択</button>' +
    '<button class="link-btn" data-key="' + key + '" data-all="0">すべて解除</button>';
  acts.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const checked = btn.dataset.all === '1';
      document.querySelectorAll('#fitems-' + key + ' input[type=checkbox]').forEach(cb => {
        cb.checked = checked;
      });
      onFilterChange(key);
    });
  });
  body.appendChild(acts);

  // チェックボックスリスト
  const items = document.createElement('div');
  items.className = 'filter-items';
  items.id = 'fitems-' + key;

  values.forEach(([val, cnt]) => {
    const id  = 'cb-' + key + '-' + Math.random().toString(36).slice(2, 8);
    const lbl = val === '' ? '(空)' : val;
    const item = document.createElement('div');
    item.className = 'filter-item';
    item.innerHTML =
      '<input type="checkbox" id="' + id + '" data-key="' + key + '" data-val="' + escAttr(val) + '">' +
      '<label for="' + id + '" title="' + escAttr(val) + '">' + escHtml(lbl) + '</label>' +
      '<span class="fi-count">' + cnt + '</span>';
    item.querySelector('input').addEventListener('change', () => onFilterChange(key));
    items.appendChild(item);
  });

  body.appendChild(items);
  sec.appendChild(body);
  return sec;
}

function onFilterChange(key) {
  const checked = [
    ...document.querySelectorAll('#fitems-' + key + ' input:checked')
  ].map(cb => cb.dataset.val);

  const badge = document.getElementById('badge-' + key);
  if (checked.length > 0) {
    badge.textContent = checked.length;
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }

  if (key === 'date') {
    state.filters.dates = checked;
  } else if (key === 'hour') {
    state.filters.hours = checked;
  } else if (key === 'cidr') {
    state.filters.cidrs = checked;
  } else if (key === 'country') {
    state.filters.countries = checked;
  } else {
    const colIdx = parseInt(key.slice(4), 10);
    state.filters.columns[colIdx] = checked;
  }

  triggerFilter();
}

// =====================================================================
// クイックフィルター (ラジオ方式)
// =====================================================================
const QUICK_BTNS = [
  { id: 'btn-weekend',  key: 'quickWeekend' },
  { id: 'btn-failed',   key: 'quickFailedLogin' },
  { id: 'btn-download', key: 'quickDownload' },
];

QUICK_BTNS.forEach(({ id, key }) => {
  document.getElementById(id).addEventListener('click', function() {
    const wasActive = state.filters[key];
    // 全ボタンをリセット
    QUICK_BTNS.forEach(b => {
      state.filters[b.key] = false;
      document.getElementById(b.id).classList.remove('active');
    });
    // クリックしたものが非アクティブだったなら ON にする
    if (!wasActive) {
      state.filters[key] = true;
      this.classList.add('active');
    }
    triggerFilter();
  });
});

// =====================================================================
// フィルター送信 (debounce 150ms)
// =====================================================================
let _filterTimer = null;
function triggerFilter() {
  if (!state.loaded) return;
  if (_filterTimer) clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => {
    _filterTimer = null;
    showRightOverlay();
    const f = JSON.parse(JSON.stringify(state.filters));
    f.ipCountryMap = state.ipCountryMap;
    f.cidrMask = state.cidrMask;
    worker.postMessage({ type: 'filter', filters: f });
  }, 150);
}

// =====================================================================
// フィルターリセット
// =====================================================================
document.getElementById('reset-btn').addEventListener('click', resetAllFilters);

function resetFiltersOnly() {
  state.filters.quickWeekend    = false;
  state.filters.quickFailedLogin = false;
  state.filters.quickDownload   = false;
  state.filters.dates     = [];
  state.filters.hours     = [];
  state.cidrMask          = 24;
  state.filters.cidrs     = [];
  state.filters.countries = [];
  state.filters.columns   = {};

  QUICK_BTNS.forEach(b => document.getElementById(b.id).classList.remove('active'));

  document.querySelectorAll('#filters-container input[type=checkbox]').forEach(cb => cb.checked = false);
  document.querySelectorAll('.filter-badge').forEach(b => b.classList.remove('show'));
  document.getElementById('reset-btn').style.display = 'none';
}

function resetAllFilters() {
  resetFiltersOnly();
  triggerFilter();
}

// =====================================================================
// チャート描画
// =====================================================================
function renderChart(rows) {
  const svg = document.getElementById('chart-svg');

  // rows から日付ごとのカウントを直接集計
  const countMap = {};
  (rows || []).forEach(r => {
    const f = r && r[0] ? String(r[0]) : '';
    if (!f) return;
    const date = f.split(' ')[0];
    countMap[date] = (countMap[date] || 0) + 1;
  });
  const chartData = Object.keys(countMap).sort().map(d => [d, countMap[d]]);

  // 仮想座標系 (viewBox="0 0 1000 128", preserveAspectRatio="none")
  const W = 1000, H = 128;
  const ML = 8, MB = 22, MT = 18, MR = 8;
  const cW = W - ML - MR;
  const cH = H - MB - MT;

  if (chartData.length === 0) {
    svg.innerHTML = '<text x="500" y="64" text-anchor="middle" fill="#ccc" font-size="14">データなし</text>';
    return;
  }

  // maxCount: spread を使わず forEach で安全に計算
  let maxCount = 1;
  chartData.forEach(function(d) {
    const v = d[1];
    if (typeof v === 'number' && v > maxCount) maxCount = v;
  });

  const n = chartData.length;
  const slotW = cW / n;
  const barW  = Math.max(2, slotW * 0.72);

  const els = [];

  // X軸ベースライン
  els.push('<line x1="' + ML + '" y1="' + (H - MB) + '" x2="' + (W - MR) + '" y2="' + (H - MB) + '" stroke="#ddd" stroke-width="1"/>');

  // バー
  const labelStep = n <= 50 ? 1 : Math.ceil(n / 50);

  chartData.forEach(function(entry, i) {
    const date  = entry[0];
    const count = entry[1];
    if (!date || typeof count !== 'number') return;

    const parts = date.split(/[\/\-]/);  // "/" も "-" も両対応
    if (parts.length < 3) return;
    const py = parseInt(parts[0], 10);
    const pm = parseInt(parts[1], 10);
    const pd = parseInt(parts[2], 10);
    if (isNaN(py) || isNaN(pm) || isNaN(pd)) return;

    const x  = ML + i * slotW + (slotW - barW) / 2;
    const bH = count <= 0 ? 0 : Math.max(2, Math.round((count / maxCount) * cH));
    const y  = H - MB - bH;

    // 土日判定
    const dObj = new Date(py, pm - 1, pd);
    const wknd = dObj.getDay() === 0 || dObj.getDay() === 6;
    const color = wknd ? '#f4a22b' : '#4285f4';

    // バー本体
    els.push(
      '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + barW.toFixed(1) + '" height="' + bH + '"' +
      ' fill="' + color + '" opacity="0.82">' +
      '<title>' + escHtml(date) + (wknd ? ' (土日)' : '') + ': ' + count + '件</title></rect>'
    );

    // 棒の上に件数ラベル
    if (bH >= 12) {
      els.push(
        '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (y - 3) + '"' +
        ' text-anchor="middle" font-size="11" fill="' + color + '" font-weight="600">' + count + '</text>'
      );
    }

    // X軸日付ラベル
    if (i % labelStep === 0) {
      els.push(
        '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (H - MB + 14) + '"' +
        ' text-anchor="middle" font-size="10" fill="#999">' + pm + '/' + pd + '</text>'
      );
    }
  });

  // 凡例
  els.push(`<rect x="${W - MR - 82}" y="6" width="10" height="10" fill="#4285f4"/>`);
  els.push(`<text x="${W - MR - 69}" y="15" font-size="11" fill="#666">平日</text>`);
  els.push(`<rect x="${W - MR - 40}" y="6" width="10" height="10" fill="#f4a22b"/>`);
  els.push(`<text x="${W - MR - 27}" y="15" font-size="11" fill="#666">土日</text>`);

  svg.innerHTML = els.join('');
}

// =====================================================================
// テーブル描画
// =====================================================================
function renderTable() {
  const rows = state.currentRows;
  const page = state.currentPage;
  const start = page * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, rows.length);
  const pageRows = rows.slice(start, end);

  const logTable  = document.getElementById('log-table');
  const emptyState = document.getElementById('empty-state');
  const pagination = document.getElementById('pagination');

  if (rows.length === 0) {
    logTable.style.display  = 'none';
    pagination.style.display = 'none';
    emptyState.style.display = 'flex';
    emptyState.querySelector('p').textContent = 'フィルターに一致するログがありません';
    return;
  }

  emptyState.style.display  = 'none';
  logTable.style.display    = 'table';
  pagination.style.display  = rows.length > PAGE_SIZE ? 'flex' : 'none';

  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';

  pageRows.forEach(row => {
    const tr = document.createElement('tr');

    // 土日行ハイライト
    const dateStr = (row[0] || '').split(' ')[0];
    const dp = dateStr.split('/');
    if (dp.length === 3) {
      const d = new Date(+dp[0], +dp[1] - 1, +dp[2]);
      if (d.getDay() === 0 || d.getDay() === 6) tr.classList.add('row-wknd');
    }

    row.forEach((cell, i) => {
      const td = document.createElement('td');
      td.title = cell || '';
      // Result 列 (index 7) はタグ表示
      if (i === 7) {
        if (cell === 'SUCCESS') {
          td.innerHTML = '<span class="tag-s">SUCCESS</span>';
        } else if (cell === 'FAILED') {
          td.innerHTML = '<span class="tag-f">FAILED</span>';
        } else {
          td.textContent = cell || '';
        }
      } else {
        td.textContent = cell || '';
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  // ページネーション
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  document.getElementById('page-info').textContent =
    `${page + 1} / ${totalPages} ページ  (${(start + 1).toLocaleString()}–${end.toLocaleString()} 件)`;
  document.getElementById('prev-btn').disabled = page === 0;
  document.getElementById('next-btn').disabled = page >= totalPages - 1;

  // テーブルデータが確定した時点でチャートを描画
  renderChart(rows);
}

document.getElementById('prev-btn').addEventListener('click', () => changePage(-1));
document.getElementById('next-btn').addEventListener('click', () => changePage(1));

function changePage(delta) {
  const total = Math.ceil(state.currentRows.length / PAGE_SIZE);
  state.currentPage = Math.max(0, Math.min(total - 1, state.currentPage + delta));
  renderTable();
  document.getElementById('table-area').scrollTop = 0;
}

// =====================================================================
// ステータス更新
// =====================================================================
function updateStatus() {
  const txt      = document.getElementById('status-text');
  const resetBtn = document.getElementById('reset-btn');

  if (!state.loaded) {
    txt.innerHTML = 'CSVファイルを開いてください';
    resetBtn.style.display = 'none';
    return;
  }

  const showing = state.currentRows.length;
  const total   = state.totalRows;
  const hasFilter = state.filters.quickWeekend || state.filters.quickFailedLogin ||
                    state.filters.quickDownload ||
                    state.filters.dates.length > 0 || state.filters.hours.length > 0 ||
                    Object.values(state.filters.columns).some(v => v.length > 0);

  if (!hasFilter) {
    txt.innerHTML = `<span class="hl">${total.toLocaleString()}</span> 件のログを表示中`;
    resetBtn.style.display = 'none';
  } else {
    txt.innerHTML =
      `<span class="hl">${showing.toLocaleString()}</span> 件 / 全 ${total.toLocaleString()} 件 (フィルター適用中)`;
    resetBtn.style.display = '';
  }
}

// =====================================================================
// ユーティリティ
// =====================================================================
function showLoading(msg) {
  document.getElementById('loading-text').textContent = msg || '処理中...';
  document.getElementById('loading').classList.add('show');
}
function hideLoading() {
  document.getElementById('loading').classList.remove('show');
}
function showRightOverlay() {
  document.getElementById('right-overlay').classList.add('show');
}
function hideRightOverlay() {
  document.getElementById('right-overlay').classList.remove('show');
}

// =====================================================================
// 左パネル リサイズ
// =====================================================================
(function() {
  const handle    = document.getElementById('resize-handle');
  const leftPanel = document.getElementById('left-panel');
  const main      = document.getElementById('main');
  let dragging = false;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const newW = Math.min(Math.max(e.clientX - rect.left, 160), rect.width - 320);
    leftPanel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
