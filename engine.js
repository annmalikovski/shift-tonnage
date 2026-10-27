/* Тоннаж по сменам — расчётный движок (без ИИ, детерминированный). */
(function (root) {
  'use strict';

  const NIGHT_MAX_HOUR = 11; // ночь: принят раньше учетного дня и начало доставки до 11:00 включительно; с 12:00 — день
  const KIND_SET = 'в составе набора';
  const KIND_SOLO = 'отдельно';
  const BLOCK_MAIN = 'Из-под ножа';
  const BLOCK_OTHER = 'Прочие';
  function normBlock(b) { const n = norm(b); return n === 'основные' || n === norm(BLOCK_MAIN) ? BLOCK_MAIN : (clean(b) || BLOCK_OTHER); }

  // ---------- нормализация названий ----------
  // Латинские буквы-двойники -> кириллица, ё -> е, регистр, кавычки, пробелы.
  const LAT2CYR = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
  function norm(s) {
    if (s == null) return '';
    let t = String(s).toLowerCase().replace(/ё/g, 'е');
    t = t.replace(/[abcehkmoptxy]/g, (ch) => LAT2CYR[ch]);
    t = t.replace(/[«»"„“”']/g, ' ').replace(/[ \s]+/g, ' ').trim();
    return t;
  }
  function clean(s) { return s == null ? '' : String(s).replace(/[ \s]+/g, ' ').trim(); }

  // ---------- даты (UTC, как их отдаёт ExcelJS) ----------
  function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000));
    return null; // строки (итоговые строки) сюда не попадают
  }
  function dayNum(d) { return Math.floor(d.getTime() / 86400000); }
  function fmtDay(d) {
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }
  function fmtDateTime(d) {
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return fmtDay(d) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  function cellValue(v) {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('result' in v) return v.result;
      if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
      if ('text' in v) return v.text;
      return null;
    }
    return v;
  }

  // ---------- разбор OLAP-выгрузки ----------
  const COLS = {
    day: ['учетный день'],
    open: ['время открытия'],
    dlv: ['планируемое время доставки'],
    cat: ['категория блюда'],
    num: ['номер доставки'],
    dish: ['блюдо'],
    size: ['размер блюда'],
  };
  const COL_TITLES = {
    day: 'Учетный день', open: 'Время открытия', dlv: 'Планируемое время доставки',
    cat: 'Категория блюда', num: 'Номер доставки', dish: 'Блюдо', size: 'Размер блюда',
  };

  function isSubtotal(v) {
    if (typeof v !== 'string') return false;
    const t = v.trim().toLowerCase();
    return t === 'итого' || t === 'всего' || t.endsWith(' всего');
  }

  // aoa: массив строк, каждая строка — массив значений ячеек (0-based)
  function parseExport(aoa) {
    let hdr = -1;
    for (let i = 0; i < Math.min(aoa.length, 30); i++) {
      const r = aoa[i] || [];
      if (r.some((v) => norm(cellValue(v)) === 'учетный день')) { hdr = i; break; }
    }
    if (hdr < 0) throw new Error('Не нашёл строку заголовков с колонкой «Учетный день». Это точно OLAP-выгрузка из iiko?');
    const head = (aoa[hdr] || []).map((v) => norm(cellValue(v)));
    const idx = {};
    for (const k of Object.keys(COLS)) {
      const j = head.findIndex((h) => COLS[k].includes(h));
      if (j < 0) throw new Error('В выгрузке нет колонки «' + COL_TITLES[k] + '». Проверьте пресет OLAP-отчёта в iiko.');
      idx[k] = j;
    }
    const qtyIdx = head.findIndex((h) => h.startsWith('количество блюд'));
    if (qtyIdx < 0) throw new Error('В выгрузке нет колонки «Количество блюд». Проверьте пресет OLAP-отчёта в iiko.');

    // шапка над таблицей: ресторан и период
    const meta = { restaurant: '', period: '', title: '' };
    for (let i = 0; i < hdr; i++) {
      const s = clean(cellValue((aoa[i] || [])[0]));
      if (!s) continue;
      if (/^название ресторана:/i.test(s)) meta.restaurant = s.replace(/^название ресторана:\s*/i, '');
      else if (/^период:/i.test(s)) meta.period = s.replace(/^период:\s*/i, '');
      else if (!meta.title) meta.title = s;
    }

    // уровни иерархии — в порядке колонок слева направо
    const keys = Object.keys(COLS).sort((a, b) => idx[a] - idx[b]);
    const cur = {};
    keys.forEach((k) => (cur[k] = null));
    const rows = [];
    let grand = null;
    for (let i = hdr + 1; i < aoa.length; i++) {
      const r = (aoa[i] || []).map(cellValue);
      const groupVals = keys.map((k) => r[idx[k]]);
      if (groupVals.some(isSubtotal)) {
        if (groupVals.some((v) => typeof v === 'string' && v.trim().toLowerCase() === 'итого')) grand = Number(r[qtyIdx]) || 0;
        continue;
      }
      const L = groupVals.findIndex((v) => v != null && v !== '');
      if (L < 0) continue;
      for (let j = L; j < keys.length; j++) {
        const v = groupVals[j];
        cur[keys[j]] = v == null || v === '' ? null : v;
      }
      const q = r[qtyIdx];
      if (q == null || q === '') continue;
      rows.push({
        day: toDate(cur.day), open: toDate(cur.open), dlv: toDate(cur.dlv),
        cat: clean(cur.cat), num: cur.num == null ? '' : String(cur.num).trim(),
        dish: clean(cur.dish), size: clean(cur.size), qty: Number(q) || 0, line: i + 1,
      });
    }
    const total = rows.reduce((s, r) => s + r.qty, 0);
    return { meta, rows, total, grand };
  }

  // ---------- справочник ----------
  function buildDict(dict) {
    const posByNorm = new Map();
    for (const p of dict.positions || []) {
      if (!p || !p.name) continue;
      posByNorm.set(norm(p.name), {
        name: clean(p.name), group: clean(p.group) || 'Без группы', block: normBlock(p.block),
        weight: Number(p.weight) || 0, order: Number(p.order) || 9999, id: p.id,
      });
    }
    const aliasExact = new Map(), aliasAny = new Map();
    for (const a of dict.aliases || []) {
      if (!a || !a.name || !a.target) continue;
      const v = { target: norm(a.target), kind: a.kind === KIND_SET ? KIND_SET : KIND_SOLO, id: a.id };
      if (clean(a.size)) aliasExact.set(norm(a.name) + '|' + norm(a.size), v);
      else aliasAny.set(norm(a.name), v);
    }
    const excl = (dict.exclusions || []).filter((x) => x && clean(x.pattern)).map((x) => ({
      match: x.match === 'равно' ? 'равно' : 'содержит',
      parts: String(x.pattern).split('+').map(norm).filter(Boolean),
      whole: norm(x.pattern), reason: clean(x.reason) || 'Не считаем', id: x.id,
    }));
    return { posByNorm, aliasExact, aliasAny, excl };
  }

  // -> {type:'pos', pos, kind} | {type:'excl', reason} | {type:'unknown', why}
  function classify(D, dish, size) {
    const nd = norm(dish), ns = norm(size);
    const tryPos = (base) => {
      if (ns) { const p = D.posByNorm.get(base + ' ' + ns); if (p) return p; }
      return D.posByNorm.get(base) || null;
    };
    const al = (ns && D.aliasExact.get(nd + '|' + ns)) || D.aliasAny.get(nd);
    if (al) {
      const p = tryPos(al.target);
      if (p) return { type: 'pos', pos: p, kind: al.kind };
    }
    const p = tryPos(nd);
    if (p) return { type: 'pos', pos: p, kind: KIND_SOLO };
    for (const x of D.excl) {
      const hit = x.match === 'равно' ? nd === x.whole : x.parts.every((part) => nd.includes(part));
      if (hit) return { type: 'excl', reason: x.reason };
    }
    if (al) return { type: 'unknown', why: 'Есть в «Названиях из отчёта», но позиции «' + al.target + '» нет в справочнике' };
    if (!ns && [...D.posByNorm.keys()].some((k) => k.startsWith(nd + ' '))) return { type: 'unknown', why: 'Не указан размер' };
    return { type: 'unknown', why: 'Нет в справочнике' };
  }

  // ---------- расчёт ----------
  function compute(parsed, dict) {
    const D = buildDict(dict);
    const src = parsed.rows;

    // 1) строки без времени доставки (чек до оформления доставки) -> время доставки этого же чека
    const byCheck = new Map();
    for (const r of src) {
      if (!r.day || !r.open) continue;
      const k = dayNum(r.day) + '|' + r.open.getTime();
      if (!byCheck.has(k)) byCheck.set(k, new Map());
      if (r.dlv) byCheck.get(k).set(r.dlv.getTime(), r.num);
    }
    let attributed = 0;
    const rows = src.map((r) => {
      if (r.dlv || !r.day || !r.open) return r;
      const m = byCheck.get(dayNum(r.day) + '|' + r.open.getTime());
      if (m && m.size === 1) {
        const [t, num] = [...m.entries()][0];
        attributed++;
        return Object.assign({}, r, { dlv: new Date(t), num: r.num || num });
      }
      return r;
    });

    // 2) свёртка: одинаковое блюдо+размер в одном заказе; взаимно гасящиеся строки (+1/−1) исчезают
    const agg = new Map();
    for (const r of rows) {
      const k = [r.day ? r.day.getTime() : '', r.open ? r.open.getTime() : '', r.dlv ? r.dlv.getTime() : '', r.num, norm(r.dish), norm(r.size)].join('|');
      const a = agg.get(k);
      if (a) { a.qty += r.qty; if (!a.cat && r.cat) a.cat = r.cat; }
      else agg.set(k, Object.assign({}, r));
    }
    const lines = [...agg.values()].filter((r) => Math.abs(r.qty) > 1e-9);

    // 3) классификация и смены
    const detail = [], excluded = new Map(), unknown = new Map(), noShift = [];
    for (const r of lines) {
      const c = classify(D, r.dish, r.size);
      if (c.type === 'excl') {
        const k = r.cat + '|' + r.dish + '|' + c.reason;
        const e = excluded.get(k) || { cat: r.cat, dish: r.dish, reason: c.reason, qty: 0 };
        e.qty += r.qty; excluded.set(k, e);
        continue;
      }
      if (c.type === 'unknown') {
        const k = norm(r.dish) + '|' + norm(r.size);
        const u = unknown.get(k) || { cat: r.cat, dish: r.dish, size: r.size, why: c.why, qty: 0, orders: new Set() };
        u.qty += r.qty; if (r.num) u.orders.add(r.num); unknown.set(k, u);
        continue;
      }
      const earlier = r.open && r.day ? dayNum(r.open) < dayNum(r.day) : false;
      const hour = r.dlv ? r.dlv.getUTCHours() : null;
      let shift;
      if (!earlier) shift = 'День';
      else if (hour == null) shift = null;
      else shift = hour <= NIGHT_MAX_HOUR ? 'Ночь' : 'День';
      const d = {
        day: r.day, open: r.open, dlv: r.dlv, hour, accepted: earlier ? 'ранее' : 'в тот же день',
        num: r.num, cat: r.cat, dish: r.dish, size: r.size,
        position: c.pos.name, group: c.pos.group, block: c.pos.block, kind: c.kind,
        qty: r.qty, shift, weight: c.pos.weight, kg: r.qty * c.pos.weight / 1000,
      };
      if (!shift) { noShift.push(d); continue; }
      detail.push(d);
    }
    detail.sort((a, b) => (a.day - b.day) || ((a.dlv || 0) - (b.dlv || 0)) || String(a.num).localeCompare(String(b.num)) || a.position.localeCompare(b.position, 'ru'));

    // 4) сводки
    const zero = () => ({ dayQty: 0, dayKg: 0, nightQty: 0, nightKg: 0 });
    const add = (t, d) => { if (d.shift === 'День') { t.dayQty += d.qty; t.dayKg += d.kg; } else { t.nightQty += d.qty; t.nightKg += d.kg; } };
    const groupOrder = new Map();
    for (const p of D.posByNorm.values()) {
      const k = p.block + '|' + p.group;
      groupOrder.set(k, Math.min(groupOrder.has(k) ? groupOrder.get(k) : 1e9, p.order));
    }
    const blocks = {};
    for (const blockName of [BLOCK_MAIN, BLOCK_OTHER]) blocks[blockName] = { name: blockName, total: zero(), inSets: zero(), groups: [] };
    const gmap = new Map();
    for (const d of detail) {
      if (!blocks[d.block]) blocks[d.block] = { name: d.block, total: zero(), inSets: zero(), groups: [] };
      const B = blocks[d.block];
      add(B.total, d);
      if (d.kind === KIND_SET) add(B.inSets, d);
      const gk = d.block + '|' + d.group;
      let G = gmap.get(gk);
      if (!G) { G = { name: d.group, total: zero(), positions: new Map(), order: groupOrder.get(gk) || 1e9 }; gmap.set(gk, G); B.groups.push(G); }
      add(G.total, d);
      let P = G.positions.get(d.position);
      if (!P) { P = Object.assign({ name: d.position, weight: d.weight }, zero()); G.positions.set(d.position, P); }
      add(P, d);
    }
    for (const B of Object.values(blocks)) {
      B.groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
      for (const G of B.groups) G.positions = [...G.positions.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    }

    const dayMap = new Map();
    for (const d of detail) {
      const k = dayNum(d.day);
      let r = dayMap.get(k);
      if (!r) { r = { day: d.day, mainDay: 0, mainNight: 0, otherDay: 0, otherNight: 0 }; dayMap.set(k, r); }
      const main = d.block === BLOCK_MAIN;
      if (d.shift === 'День') r[main ? 'mainDay' : 'otherDay'] += d.kg; else r[main ? 'mainNight' : 'otherNight'] += d.kg;
    }
    const byDay = [...dayMap.values()].sort((a, b) => a.day - b.day);

    const days = detail.map((d) => d.day).concat(noShift.map((d) => d.day)).filter(Boolean);
    const first = days.length ? new Date(Math.min(...days.map(Number))) : null;
    const last = days.length ? new Date(Math.max(...days.map(Number))) : null;

    return {
      meta: Object.assign({}, parsed.meta, {
        firstDay: first, lastDay: last, periodLabel: first ? fmtDay(first) + ' – ' + fmtDay(last) : '',
        sourceRows: parsed.rows.length, sourceQty: parsed.total, grandTotal: parsed.grand, attributed,
      }),
      blocks, byDay, detail, noShift,
      excluded: [...excluded.values()].filter((e) => Math.abs(e.qty) > 1e-9).sort((a, b) => a.reason.localeCompare(b.reason, 'ru') || a.dish.localeCompare(b.dish, 'ru')),
      unknown: [...unknown.values()].filter((u) => Math.abs(u.qty) > 1e-9).map((u) => Object.assign(u, { orders: [...u.orders] })).sort((a, b) => b.qty - a.qty),
    };
  }

  // ---------- Excel ----------
  async function buildWorkbook(ExcelJS, res, opts) {
    opts = opts || {};
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Тоннаж по сменам';
    wb.created = new Date();
    const C = { ink: 'FF1F2A44', day: 'FFFBEFD6', night: 'FFE3E8F7', head: 'FFEEF0F4', group: 'FFF6F7F9', warn: 'FFFFF1E6', line: 'FFD5D9E0' };
    const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
    const border = { bottom: { style: 'thin', color: { argb: C.line } } };
    const F_QTY = '#,##0', F_KG = '#,##0.0', F_T = '0.000', F_PCT = '0.0%';
    const subtitle = [res.meta.restaurant, res.meta.periodLabel ? 'учетные дни ' + res.meta.periodLabel : '', opts.fileName ? 'выгрузка: ' + opts.fileName : ''].filter(Boolean).join(' · ');

    function summarySheet(B, sheetName, heading, scope) {
      const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 6 }] });
      ws.columns = [{ width: 42 }].concat(Array(9).fill({ width: 12 }));
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
      ws.getCell('A1').value = 'Тоннаж по сменам — ' + heading;
      ws.getCell('A1').font = { bold: true, size: 14, color: { argb: C.ink } };
      ws.getCell('A2').value = scope;
      ws.getCell('A3').value = subtitle;
      ws.getCell('A2').font = ws.getCell('A3').font = { color: { argb: 'FF5B6475' } };
      let row = 4;
      if (res.unknown.length) {
        ws.getCell('A4').value = 'Внимание: ' + res.unknown.length + ' назв. не распознано и не вошло в расчёт — см. лист «Не распознано»';
        ws.getCell('A4').font = { bold: true, color: { argb: 'FFB54708' } };
      }
      row = 5;
      const hdr1 = ws.getRow(row); hdr1.values = ['', 'Дневная смена', '', '', 'Ночная смена', '', '', 'Всего', '', ''];
      ws.mergeCells(row, 2, row, 4); ws.mergeCells(row, 5, row, 7); ws.mergeCells(row, 8, row, 10);
      const hdr2 = ws.getRow(row + 1); hdr2.values = ['Группа / позиция', 'Кол-во, шт', 'Вес, кг', 'Вес, т', 'Кол-во, шт', 'Вес, кг', 'Вес, т', 'Кол-во, шт', 'Вес, кг', 'Вес, т'];
      for (const r of [hdr1, hdr2]) r.eachCell({ includeEmpty: true }, (c, n) => {
        c.font = { bold: true, color: { argb: C.ink } };
        c.alignment = { horizontal: n === 1 ? 'left' : 'center', vertical: 'middle', wrapText: true };
        c.fill = fill(n >= 2 && n <= 4 ? C.day : n >= 5 && n <= 7 ? C.night : C.head);
      });
      row += 2;
      const put = (label, t, style) => {
        const r = ws.getRow(row++);
        r.values = [label, t.dayQty, t.dayKg, t.dayKg / 1000, t.nightQty, t.nightKg, t.nightKg / 1000, t.dayQty + t.nightQty, t.dayKg + t.nightKg, (t.dayKg + t.nightKg) / 1000];
        [2, 5, 8].forEach((n) => (r.getCell(n).numFmt = F_QTY));
        [3, 6, 9].forEach((n) => (r.getCell(n).numFmt = F_KG));
        [4, 7, 10].forEach((n) => (r.getCell(n).numFmt = F_T));
        r.eachCell({ includeEmpty: true }, (c) => (c.border = border));
        if (style === 'group') r.eachCell({ includeEmpty: true }, (c) => { c.font = { bold: true }; c.fill = fill(C.group); });
        if (style === 'total') r.eachCell({ includeEmpty: true }, (c) => { c.font = { bold: true }; c.fill = fill(C.head); });
        if (style === 'muted') r.eachCell({ includeEmpty: true }, (c) => { c.font = { italic: true, color: { argb: 'FF5B6475' } }; });
        return r;
      };
      ws.getCell('A' + row).value = 'По группам'; ws.getCell('A' + row).font = { bold: true }; row++;
      for (const G of B.groups) put(G.name, G.total);
      put('ИТОГО', B.total, 'total');
      const all = B.total.dayKg + B.total.nightKg;
      const sr = ws.getRow(row++);
      sr.values = ['Доля смены по весу', null, null, all ? B.total.dayKg / all : 0, null, null, all ? B.total.nightKg / all : 0];
      sr.getCell(4).numFmt = sr.getCell(7).numFmt = F_PCT;
      put('в т.ч. в составе наборов', B.inSets, 'muted');
      row++;
      ws.getCell('A' + row).value = 'По позициям'; ws.getCell('A' + row).font = { bold: true }; row++;
      for (const G of B.groups) {
        put(G.name, G.total, 'group');
        for (const P of G.positions) put('   ' + P.name, P);
      }
      put('ИТОГО по позициям', B.total, 'total');
    }

    summarySheet(res.blocks[BLOCK_MAIN], 'Итог из-под ножа', 'из-под ножа', 'Русские пироги, наборы мини-русских пирогов, Лапландский, Лиссабонский, Баноффи пай (24 и 18 см)');
    summarySheet(res.blocks[BLOCK_OTHER], 'Итог прочие', 'прочие позиции', 'Остальные песочные пироги 24 и 18 см, тарталетки, наборы тарталеток (в т.ч. из наборов с пустой ТТК)');

    // По дням
    {
      const ws = wb.addWorksheet('По дням', { views: [{ state: 'frozen', ySplit: 4 }] });
      ws.columns = [{ width: 14 }].concat(Array(7).fill({ width: 13 }));
      ws.getCell('A1').value = 'Тоннаж по учетным дням и сменам · ' + res.meta.periodLabel;
      ws.getCell('A1').font = { bold: true, size: 13 };
      const h1 = ws.getRow(3); h1.values = ['', BLOCK_MAIN, '', BLOCK_OTHER, '', 'Всего', '', ''];
      ws.mergeCells(3, 2, 3, 3); ws.mergeCells(3, 4, 3, 5); ws.mergeCells(3, 6, 3, 8);
      const h2 = ws.getRow(4); h2.values = ['Учетный день', 'День, кг', 'Ночь, кг', 'День, кг', 'Ночь, кг', 'День, т', 'Ночь, т', 'Всего, т'];
      for (const r of [h1, h2]) r.eachCell({ includeEmpty: true }, (c) => { c.font = { bold: true }; c.fill = fill(C.head); c.alignment = { horizontal: 'center', wrapText: true }; });
      let row = 5;
      const tot = { mainDay: 0, mainNight: 0, otherDay: 0, otherNight: 0 };
      const put = (label, r, bold) => {
        const x = ws.getRow(row++);
        const dt = (r.mainDay + r.otherDay) / 1000, nt = (r.mainNight + r.otherNight) / 1000;
        x.values = [label, r.mainDay, r.mainNight, r.otherDay, r.otherNight, dt, nt, dt + nt];
        [2, 3, 4, 5].forEach((n) => (x.getCell(n).numFmt = F_KG));
        [6, 7, 8].forEach((n) => (x.getCell(n).numFmt = F_T));
        x.eachCell({ includeEmpty: true }, (c) => { c.border = border; if (bold) { c.font = { bold: true }; c.fill = fill(C.head); } });
      };
      for (const r of res.byDay) { put(fmtDay(r.day), r); for (const k in tot) tot[k] += r[k]; }
      put('ИТОГО', tot, true);
    }

    // Детализация
    {
      const ws = wb.addWorksheet('Детализация', { views: [{ state: 'frozen', ySplit: 1 }] });
      const cols = [
        ['Учетный день', 12], ['Время открытия', 16], ['Планируемое время доставки', 16], ['Час доставки', 8],
        ['Заказ принят', 14], ['№ доставки', 11], ['Категория в отчёте', 18], ['Блюдо в отчёте', 30], ['Размер в отчёте', 9],
        ['Позиция', 34], ['Группа', 24], ['Блок', 10], ['Как продано', 16], ['Кол-во, шт', 9], ['Смена', 8], ['Вес 1 шт, г', 10], ['Итого, кг', 10],
      ];
      ws.columns = cols.map(([header, width]) => ({ header, width }));
      ws.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = fill(C.head); c.alignment = { wrapText: true, vertical: 'middle' }; });
      for (const d of res.detail) {
        const r = ws.addRow([d.day, d.open, d.dlv, d.hour, d.accepted, d.num ? (isNaN(+d.num) ? d.num : +d.num) : '', d.cat, d.dish, d.size, d.position, d.group, d.block, d.kind, d.qty, d.shift, d.weight, d.kg]);
        r.getCell(1).numFmt = 'dd.mm.yyyy';
        r.getCell(2).numFmt = r.getCell(3).numFmt = 'dd.mm.yyyy hh:mm';
        r.getCell(17).numFmt = '0.000';
        r.getCell(15).fill = fill(d.shift === 'День' ? C.day : C.night);
      }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }

    // Не распознано
    if (res.unknown.length || res.noShift.length) {
      const ws = wb.addWorksheet('Не распознано');
      ws.columns = [{ header: 'Категория в отчёте', width: 20 }, { header: 'Блюдо в отчёте', width: 40 }, { header: 'Размер', width: 10 }, { header: 'Кол-во, шт', width: 10 }, { header: 'Причина', width: 50 }, { header: 'Примеры заказов', width: 30 }];
      ws.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = fill(C.warn); });
      for (const u of res.unknown) ws.addRow([u.cat, u.dish, u.size, u.qty, u.why + ' — добавьте на странице расчёта и пересчитайте', u.orders.slice(0, 5).join(', ')]);
      for (const d of res.noShift) ws.addRow([d.cat, d.dish, d.size, d.qty, 'Принят раньше учетного дня, но нет времени доставки — смену не определить', d.num]);
    }

    // Не учтено
    {
      const ws = wb.addWorksheet('Не учтено');
      ws.columns = [{ header: 'Категория в отчёте', width: 22 }, { header: 'Позиция', width: 44 }, { header: 'Кол-во, шт', width: 10 }, { header: 'Почему не учтено', width: 62 }];
      ws.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = fill(C.head); });
      for (const e of res.excluded) ws.addRow([e.cat || '—', e.dish, e.qty, e.reason]);
    }

    // Справочник
    {
      const ws = wb.addWorksheet('Справочник');
      ws.columns = [{ header: 'Позиция', width: 40 }, { header: 'Группа', width: 28 }, { header: 'Блок', width: 11 }, { header: 'Вес 1 шт, г', width: 11 }, { header: 'Откуда вес', width: 60 }];
      ws.getRow(1).eachCell((c) => { c.font = { bold: true }; c.fill = fill(C.head); });
      const ps = (opts.dict && opts.dict.positions || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const p of ps) ws.addRow([p.name, p.group, p.block, Number(p.weight) || 0, p.note || '']);
      const als = (opts.dict && opts.dict.aliases) || [];
      if (als.length) {
        ws.addRow([]);
        const h = ws.addRow(['Название в отчёте', 'Размер в отчёте', 'Как продано', 'Считается как позиция']);
        h.eachCell((c) => { c.font = { bold: true }; c.fill = fill(C.head); });
        for (const a of als) ws.addRow([a.name, a.size || 'любой', a.kind || KIND_SOLO, a.target]);
      }
    }

    // Правила
    {
      const ws = wb.addWorksheet('Правила');
      ws.getColumn(1).width = 120;
      const lines = [
        ['Правила распределения по сменам', true],
        ['• Дневная смена: все заказы, принятые в тот же учетный день (дата открытия чека = учетный день), при любом времени доставки; плюс заказы, принятые в предыдущие даты, с началом доставки с ' + (NIGHT_MAX_HOUR + 1) + ':00.'],
        ['• Ночная смена: заказы, принятые раньше учетного дня, с началом доставки до ' + NIGHT_MAX_HOUR + ':00 включительно. Учитывается только час начала доставки: ' + NIGHT_MAX_HOUR + ' ч — ночь, ' + (NIGHT_MAX_HOUR + 1) + ' ч — день; минуты и секунды не важны.'],
        [''],
        ['Как считается', true],
        ['• Вес — из справочника (вес по номиналу из меню, например «900+-50 гр» → 900 г). Справочник правится на странице расчёта.'],
        ['• Названия сравниваются без учёта регистра, ё/е, кавычек и латинских букв-двойников (например, «Брюсcельский» с латинской c).'],
        ['• Пироги и тарталетки из наборов с пустой ТТК считаются по строкам-модификаторам («Американский», «Средний Украинский», «Норвежская» и т. п.); сами такие наборы не считаются.'],
        ['• Строки одного заказа, которые гасят друг друга (+1 и −1 при смене размера или переносе в доставку), сворачиваются; позиции, введённые до оформления доставки, относятся к времени доставки этого же чека.'],
        ['• Торты, чизкейки, напитки и морсы, доставка, посуда и служебные строки не считаются (лист «Не учтено»).'],
        ['• Всё, чего нет в справочнике, попадает на лист «Не распознано» и в расчёт не входит, пока не будет добавлено.'],
        [''],
        ['Источник', true],
        ['• ' + subtitle],
        ['• Строк в выгрузке: ' + res.meta.sourceRows + ', блюд всего: ' + res.meta.sourceQty + (res.meta.grandTotal != null ? ' (итог в выгрузке: ' + res.meta.grandTotal + ')' : '')],
        ['• Рассчитано: ' + new Date().toLocaleString('ru-RU')],
      ];
      for (const [t, b] of lines) { const r = ws.addRow([t]); r.getCell(1).alignment = { wrapText: true, vertical: 'top' }; if (b) r.getCell(1).font = { bold: true, size: 12 }; }
    }

    return wb;
  }

  // ---------- быстрый ридер xlsx (выгрузки iiko содержат десятки тысяч объединённых ячеек) ----------
  function xmlDecode(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
      if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&';
      if (e === 'quot') return '"'; if (e === 'apos') return "'";
      return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }
  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }
  async function readXlsx(JSZip, data) {
    let zip;
    try { zip = await JSZip.loadAsync(data); } catch (e) { throw new Error('Не получилось открыть файл как Excel (.xlsx). Выгрузите отчёт из iiko в формате Excel.'); }
    const file = (p) => zip.file(p) || zip.file(p.replace(/^\//, ''));
    // первый лист книги
    let sheetPath = null;
    const wbx = file('xl/workbook.xml'), rels = file('xl/_rels/workbook.xml.rels');
    if (wbx && rels) {
      const w = await wbx.async('string'), r = await rels.async('string');
      const m = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(w) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(w);
      if (m) {
        const rm = new RegExp('<Relationship\\b[^>]*\\bId="' + m[1] + '"[^>]*>').exec(r);
        const tm = rm && /Target="([^"]+)"/.exec(rm[0]);
        if (tm) sheetPath = tm[1].startsWith('/') ? tm[1].slice(1) : 'xl/' + tm[1].replace(/^\.\//, '');
      }
    }
    if (!sheetPath || !file(sheetPath)) {
      const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort();
      sheetPath = names[0];
    }
    if (!sheetPath) throw new Error('В файле нет листов с данными.');
    const shared = [];
    const ssf = file('xl/sharedStrings.xml');
    if (ssf) {
      const ss = await ssf.async('string');
      const siRe = /<si>([\s\S]*?)<\/si>|<si\/>/g, tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let m;
      while ((m = siRe.exec(ss))) {
        let s = '', t;
        if (m[1]) { tRe.lastIndex = 0; while ((t = tRe.exec(m[1]))) s += t[1]; }
        shared.push(xmlDecode(s));
      }
    }
    const xml = await file(sheetPath).async('string');
    const aoa = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rm, auto = 0;
    while ((rm = rowRe.exec(xml))) {
      const rn = /\br="(\d+)"/.exec(rm[1]);
      const ri = rn ? +rn[1] - 1 : auto;
      auto = ri + 1;
      const arr = [];
      if (rm[2]) {
        let cm, ci = 0;
        cRe.lastIndex = 0;
        while ((cm = cRe.exec(rm[2]))) {
          const a = cm[1], body = cm[2] || '';
          const ref = /\br="([A-Z]+)\d+"/.exec(a);
          const col = ref ? colIndex(ref[1]) : ci;
          ci = col + 1;
          const t = (/\bt="([^"]+)"/.exec(a) || [])[1] || 'n';
          let v = null;
          if (t === 'inlineStr') {
            const it = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
            v = it ? xmlDecode(it[1]) : '';
          } else {
            const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
            if (vm) {
              if (t === 's') v = shared[+vm[1]];
              else if (t === 'str' || t === 'e') v = xmlDecode(vm[1]);
              else if (t === 'b') v = vm[1] === '1';
              else v = Number(vm[1]);
            }
          }
          arr[col] = v;
        }
      }
      for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = null;
      aoa[ri] = arr;
    }
    for (let i = 0; i < aoa.length; i++) if (!aoa[i]) aoa[i] = [];
    return aoa;
  }

  // ExcelJS worksheet -> массив строк
  function sheetToAoa(ws) {
    const out = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = row.values; // 1-based
      const arr = [];
      for (let i = 1; i < vals.length; i++) arr.push(vals[i] === undefined ? null : vals[i]);
      out[n - 1] = arr;
    });
    for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
    return out;
  }

  const api = { norm, parseExport, compute, classify, buildDict, buildWorkbook, sheetToAoa, readXlsx, fmtDay, fmtDateTime, KIND_SET, KIND_SOLO, BLOCK_MAIN, BLOCK_OTHER, NIGHT_MAX_HOUR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TonnageEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
