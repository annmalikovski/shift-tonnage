/* Тоннаж по сменам — страница для GitHub Pages.
   Расчёт: engine.js. Справочник: spravochnik.json в этом же репозитории.
   Правки справочника сохраняются коммитом через GitHub API (нужен токен с правом записи в репозиторий). */
(function () {
  'use strict';

  // Где лежит справочник. Если переименуете репозиторий — поменяйте здесь.
  const GH = { owner: 'annmalikovski', repo: 'shift-tonnage', branch: 'main', file: 'spravochnik.json' };
  const API = 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo;
  const TOKEN_KEY = 'tonnazh.githubToken';

  const E = window.TonnageEngine;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf3 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const COLLS = ['positions', 'aliases', 'exclusions'];

  const S = {
    base: null, sha: null, source: '', lastCommit: null, loadError: '',
    ops: [], dict: { positions: [], aliases: [], exclusions: [] },
    fileName: '', parsed: null, res: null, error: '',
    tab: 'positions', block: E.BLOCK_MAIN, dictTab: 'positions', filter: '', dictDirty: false, saving: false,
  };

  // ---------- токен ----------
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* хранилище недоступно */ } }
  function ghHeaders(withToken) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const t = withToken !== false ? getToken() : '';
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  // ---------- base64 <-> UTF-8 ----------
  function b64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ---------- справочник: загрузка ----------
  function normalizeDict(d) {
    const out = {};
    for (const c of COLLS) out[c] = Array.isArray(d && d[c]) ? d[c].filter((x) => x && x.id) : [];
    return out;
  }
  async function fetchFromApi(withToken) {
    const r = await fetch(API + '/contents/' + GH.file + '?ref=' + GH.branch, { headers: ghHeaders(withToken), cache: 'no-store' });
    if (!r.ok) { const e = new Error('GitHub ответил ' + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    return { dict: normalizeDict(JSON.parse(b64ToUtf8(j.content))), sha: j.sha };
  }
  async function loadDict() {
    S.loadError = '';
    try {
      let got;
      try { got = await fetchFromApi(true); }
      catch (e) { if (e.status === 401 && getToken()) got = await fetchFromApi(false); else throw e; }
      S.base = got.dict; S.sha = got.sha; S.source = 'github';
    } catch (e) {
      try {
        const r = await fetch(GH.file + '?v=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('файл не найден (' + r.status + ')');
        S.base = normalizeDict(await r.json()); S.sha = null; S.source = 'site';
      } catch (e2) {
        S.loadError = 'Не удалось загрузить справочник: ' + (e2.message || e2);
      }
    }
    applyDict();
    loadLastCommit();
  }
  async function loadLastCommit() {
    try {
      const r = await fetch(API + '/commits?path=' + GH.file + '&sha=' + GH.branch + '&per_page=1', { headers: ghHeaders(), cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j[0]) { S.lastCommit = { date: new Date(j[0].commit.committer.date), message: j[0].commit.message, url: j[0].html_url }; renderChip(); }
    } catch (e) { /* не критично */ }
  }

  // ---------- правки: локальный черновик ----------
  function newId(prefix) { return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function applyOps(base, ops) {
    const d = {};
    for (const c of COLLS) d[c] = (base ? base[c] : []).map((x) => Object.assign({}, x));
    for (const op of ops) {
      const arr = d[op.c];
      const i = arr.findIndex((x) => x.id === (op.id || (op.doc && op.doc.id)));
      if (op.t === 'add') { if (i >= 0) arr[i] = Object.assign({}, op.doc); else arr.push(Object.assign({}, op.doc)); }
      else if (op.t === 'upd' && i >= 0) arr[i][op.f] = op.v;
      else if (op.t === 'del' && i >= 0) arr.splice(i, 1);
    }
    return d;
  }
  function addDoc(c, doc) { S.ops.push({ t: 'add', c, doc: Object.assign({ id: newId(c[0]) }, doc) }); applyDict(); }
  function updDoc(c, id, f, v) { S.ops.push({ t: 'upd', c, id, f, v }); applyDict(); }
  function delDoc(c, id) { S.ops.push({ t: 'del', c, id }); applyDict(); }
  function applyDict() {
    S.dict = applyOps(S.base, S.ops);
    recompute(); renderChip(); renderResults(); renderDict(false); renderPending();
  }
  function opsSummary(ops) {
    const n = { add: 0, upd: 0, del: 0 };
    const names = [];
    const before = S.base || { positions: [], aliases: [], exclusions: [] };
    for (const op of ops) {
      n[op.t]++;
      if (names.length < 3) {
        if (op.t === 'add') names.push('+ ' + (op.doc.name || op.doc.pattern) + (op.doc.target ? ' → ' + op.doc.target : ''));
        else {
          const x = (before[op.c] || []).find((y) => y.id === op.id) || {};
          names.push((op.t === 'del' ? '− ' : '~ ') + (x.name || x.pattern || op.id) + (op.t === 'upd' ? ': ' + op.f + ' = ' + op.v : ''));
        }
      }
    }
    const parts = [];
    if (n.add) parts.push('добавлено ' + n.add); if (n.upd) parts.push('изменено ' + n.upd); if (n.del) parts.push('удалено ' + n.del);
    return 'Справочник: ' + parts.join(', ') + '\n\n' + names.join('\n') + (ops.length > 3 ? '\n…' : '');
  }
  function serialize(d) {
    return '{\n' + COLLS.map((c) => '  "' + c + '": [\n' + d[c].map((x) => '    ' + JSON.stringify(x)).join(',\n') + '\n  ]').join(',\n') + '\n}\n';
  }

  async function saveToGitHub() {
    if (!S.ops.length || S.saving) return;
    if (!getToken()) { openToken('Чтобы сохранить правки в общий справочник, нужен токен GitHub.'); return; }
    S.saving = true; renderPending();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!S.sha || attempt > 0) { const got = await fetchFromApi(true); S.base = got.dict; S.sha = got.sha; }
        const next = applyOps(S.base, S.ops);
        const r = await fetch(API + '/contents/' + GH.file, {
          method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
          body: JSON.stringify({ message: opsSummary(S.ops), content: utf8ToB64(serialize(next)), sha: S.sha, branch: GH.branch }),
        });
        if (r.ok) {
          const j = await r.json();
          S.base = next; S.sha = j.content && j.content.sha; S.ops = []; S.source = 'github';
          applyDict(); loadLastCommit();
          toast('Сохранено в справочник. Другие увидят правки, как только обновят страницу.');
          return;
        }
        if ((r.status === 409 || r.status === 422) && attempt === 0) continue; // кто-то сохранил раньше — берём свежую версию и повторяем
        if (r.status === 401) throw new Error('токен не подходит или истёк — введите новый');
        if (r.status === 403 || r.status === 404) throw new Error('у токена нет права записи в репозиторий ' + GH.owner + '/' + GH.repo);
        throw new Error('GitHub ответил ' + r.status);
      }
      throw new Error('справочник меняли одновременно с вами — обновите страницу и повторите');
    } catch (e) {
      toast('Не сохранилось: ' + (e.message || e));
      if (/токен/.test(e.message || '')) openToken('Не сохранилось: ' + e.message);
    } finally { S.saving = false; renderPending(); }
  }
  function discardOps() { S.ops = []; applyDict(); toast('Правки отменены'); }
  window.addEventListener('beforeunload', (e) => { if (S.ops.length) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- шкала часов ----------
  (function drawRule() {
    const same = $('#stripSame'), earl = $('#stripEarlier'), ticks = $('#ticks');
    for (let h = 0; h < 24; h++) {
      const a = document.createElement('i'); a.title = h + ':00 — дневная смена'; same.appendChild(a);
      const b = document.createElement('i'); const n = h <= E.NIGHT_MAX_HOUR; if (n) b.className = 'n';
      b.title = h + ':00 — ' + (n ? 'ночная' : 'дневная') + ' смена'; earl.appendChild(b);
    }
    for (const h of [0, 6, 14, 23]) {
      const s = document.createElement('span'); s.textContent = h; s.style.left = ((h + 0.5) / 24 * 100) + '%'; ticks.appendChild(s);
    }
  })();

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000);
  }

  // ---------- файл ----------
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { if (!e.target.closest || !e.target.closest('.drop')) { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); } });

  async function loadFile(f) {
    S.error = ''; S.fileName = f.name;
    renderUpload(true);
    try {
      if (!window.JSZip) throw new Error('Не загрузилась библиотека для чтения Excel. Обновите страницу.');
      const aoa = await E.readXlsx(window.JSZip, await f.arrayBuffer());
      S.parsed = E.parseExport(aoa);
      if (!S.parsed.rows.length) throw new Error('В файле не нашлось строк с блюдами. Проверьте период и фильтры выгрузки.');
      recompute();
    } catch (e) {
      S.parsed = null; S.res = null; S.error = e && e.message ? e.message : String(e);
    }
    renderUpload(false); renderResults();
  }
  function recompute() { S.res = S.parsed && S.base ? E.compute(S.parsed, S.dict) : null; }

  function renderUpload(busy) {
    const slot = $('#uploadSlot');
    if (busy) { drop.querySelector('.big').innerHTML = '<span class="spin"></span> Читаю «' + esc(S.fileName) + '»…'; return; }
    drop.querySelector('.big').textContent = S.parsed ? 'Загрузить другую выгрузку' : 'Перетащите выгрузку из iiko сюда';
    let card = $('#fileCard');
    if (!S.parsed && !S.error) { if (card) card.remove(); return; }
    if (!card) { card = document.createElement('div'); card.id = 'fileCard'; card.style.marginTop = '12px'; slot.appendChild(card); }
    if (S.error) { card.className = 'alert'; card.innerHTML = '<h3>Не получилось посчитать «' + esc(S.fileName) + '»</h3><p>' + esc(S.error) + '</p>'; return; }
    const m = S.parsed.meta, okSum = S.parsed.grand == null || Math.abs(S.parsed.grand - S.parsed.total) < 1e-6;
    card.className = 'filecard';
    card.innerHTML = '<div><div class="name">' + esc(S.fileName) + '</div><div class="small muted">' + esc([m.restaurant, m.period].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="small ' + (okSum ? 'check' : 'muted') + '">' + (okSum ? '✓ ' : '') + nf0.format(S.parsed.total) + ' блюд прочитано' + (S.parsed.grand != null ? (okSum ? ', совпадает с итогом выгрузки' : ' (в итоге выгрузки ' + nf0.format(S.parsed.grand) + ')') : '') + '</div>';
  }

  // ---------- результаты ----------
  function tot(t) { return { q: t.dayQty + t.nightQty, kg: t.dayKg + t.nightKg }; }
  function kpiCard(B, title, scope) {
    const t = B.total, all = tot(t), dp = pct(t.dayKg, all.kg), np = all.kg ? 100 - dp : 0;
    return '<article class="kpi"><div><h3>' + esc(title) + '</h3><div class="small muted">' + esc(scope) + '</div></div>' +
      '<div class="total">' + nf3.format(all.kg / 1000) + '<small>т · ' + nf0.format(all.q) + ' шт</small></div>' +
      '<div class="split" role="img" aria-label="День ' + dp + '%, ночь ' + np + '%"><div class="d" style="width:' + dp + '%"></div><div class="n" style="width:' + np + '%"></div></div>' +
      '<div class="shifts"><div class="shift d"><div class="small">Дневная · ' + dp + '%</div><div class="v">' + nf3.format(t.dayKg / 1000) + ' т</div><div class="s">' + nf0.format(t.dayQty) + ' шт · ' + nf1.format(t.dayKg) + ' кг</div></div>' +
      '<div class="shift n"><div class="small">Ночная · ' + np + '%</div><div class="v">' + nf3.format(t.nightKg / 1000) + ' т</div><div class="s">' + nf0.format(t.nightQty) + ' шт · ' + nf1.format(t.nightKg) + ' кг</div></div></div>' +
      '<div class="foot">в т.ч. из наборов: ' + nf0.format(B.inSets.dayQty + B.inSets.nightQty) + ' шт · ' + nf1.format(B.inSets.dayKg + B.inSets.nightKg) + ' кг</div></article>';
  }
  function row(cls, label, t) {
    const a = tot(t);
    return '<tr class="' + cls + '"><td>' + esc(label) + '</td><td class="d">' + nf0.format(t.dayQty) + '</td><td class="d">' + nf1.format(t.dayKg) + '</td><td class="n">' + nf0.format(t.nightQty) + '</td><td class="n">' + nf1.format(t.nightKg) + '</td><td>' + nf0.format(a.q) + '</td><td>' + nf1.format(a.kg) + '</td><td>' + nf3.format(a.kg / 1000) + '</td></tr>';
  }
  function blockTable(B) {
    let h = '<table><thead><tr class="top"><th></th><th class="d" colspan="2">Дневная смена</th><th class="n" colspan="2">Ночная смена</th><th colspan="3">Всего</th></tr>' +
      '<tr><th>Позиция</th><th class="d">шт</th><th class="d">кг</th><th class="n">шт</th><th class="n">кг</th><th>шт</th><th>кг</th><th>т</th></tr></thead><tbody>';
    for (const G of B.groups) { h += row('g', G.name, G.total); for (const P of G.positions) h += row('p', P.name, P); }
    return h + row('tot', 'Итого', B.total) + row('sub', 'в т.ч. из наборов', B.inSets) + '</tbody></table>';
  }
  function daysTable(res) {
    const max = Math.max(1, ...res.byDay.map((r) => r.mainDay + r.mainNight + r.otherDay + r.otherNight));
    let h = '<table><thead><tr class="top"><th></th><th colspan="2">' + E.BLOCK_MAIN + ', кг</th><th colspan="2">Прочие, кг</th><th colspan="4">Всего</th></tr>' +
      '<tr><th>Учетный день</th><th class="d">день</th><th class="n">ночь</th><th class="d">день</th><th class="n">ночь</th><th class="d">день, т</th><th class="n">ночь, т</th><th>всего, т</th><th></th></tr></thead><tbody>';
    const T = { mainDay: 0, mainNight: 0, otherDay: 0, otherNight: 0 };
    for (const r of res.byDay) {
      for (const k in T) T[k] += r[k];
      const d = r.mainDay + r.otherDay, n = r.mainNight + r.otherNight;
      h += '<tr><td>' + E.fmtDay(r.day) + '</td><td class="d">' + nf1.format(r.mainDay) + '</td><td class="n">' + nf1.format(r.mainNight) + '</td><td class="d">' + nf1.format(r.otherDay) + '</td><td class="n">' + nf1.format(r.otherNight) + '</td><td class="d">' + nf3.format(d / 1000) + '</td><td class="n">' + nf3.format(n / 1000) + '</td><td>' + nf3.format((d + n) / 1000) + '</td>' +
        '<td><div class="daybar" title="день ' + nf1.format(d) + ' кг, ночь ' + nf1.format(n) + ' кг"><i class="d" style="width:' + (d / max * 100) + '%"></i><i class="n" style="width:' + (n / max * 100) + '%"></i></div></td></tr>';
    }
    const d = T.mainDay + T.otherDay, n = T.mainNight + T.otherNight;
    return h + '<tr class="tot"><td>Итого</td><td>' + nf1.format(T.mainDay) + '</td><td>' + nf1.format(T.mainNight) + '</td><td>' + nf1.format(T.otherDay) + '</td><td>' + nf1.format(T.otherNight) + '</td><td>' + nf3.format(d / 1000) + '</td><td>' + nf3.format(n / 1000) + '</td><td>' + nf3.format((d + n) / 1000) + '</td><td></td></tr></tbody></table>';
  }
  function exclTable(res) {
    if (!res.excluded.length) return '<div class="empty">Ничего не исключено.</div>';
    let h = '<table><thead><tr><th>Название в отчёте</th><th>Категория</th><th>шт</th><th style="text-align:left">Почему не считаем</th></tr></thead><tbody>';
    for (const e of res.excluded) h += '<tr><td>' + esc(e.dish) + '</td><td style="text-align:left">' + esc(e.cat || '—') + '</td><td>' + nf0.format(e.qty) + '</td><td style="text-align:left;white-space:normal">' + esc(e.reason) + '</td></tr>';
    return h + '</tbody></table>';
  }
  function groupsList() { return [...new Set(S.dict.positions.map((p) => p.group).filter(Boolean))]; }

  function unknownBox(res) {
    const items = res.unknown, ns = res.noShift;
    if (!items.length && !ns.length) return '';
    let h = '<div class="alert" id="unknownBox"><div><h3>' + (items.length ? 'Не распознано: ' + items.length + ' назв. — эти блюда не вошли в расчёт' : 'Есть строки без смены') + '</h3>' +
      '<p class="small">Сопоставьте с позицией из справочника, добавьте новую позицию или отметьте «не считать». Расчёт обновится сразу; чтобы правка осталась в общем справочнике, нажмите «Сохранить» внизу.</p></div>';
    items.forEach((u, i) => {
      h += '<div class="unk" data-i="' + i + '"><div class="t"><b>' + esc(u.dish) + '</b>' + (u.size ? '<span class="small">размер: ' + esc(u.size) + '</span>' : '') +
        '<span class="small muted">' + esc(u.cat || 'без категории') + ' · ' + nf0.format(u.qty) + ' шт · ' + esc(u.why) + (u.orders.length ? ' · заказы ' + esc(u.orders.slice(0, 3).join(', ')) : '') + '</span></div>' +
        '<div class="acts"><input list="dlPositions" class="u-target fld" placeholder="Позиция из справочника" aria-label="Позиция из справочника" style="flex:1 1 220px">' +
        '<select class="u-kind fld" aria-label="Как продано"><option>' + E.KIND_SOLO + '</option><option>' + E.KIND_SET + '</option></select>' +
        '<button class="btn small primary" data-act="map">Сопоставить</button><button class="btn small" data-act="newpos">Новая позиция…</button><button class="btn small" data-act="skip">Не считать…</button></div>' +
        '<div class="form" hidden></div></div>';
    });
    for (const d of ns) h += '<div class="unk"><div class="t"><b>' + esc(d.dish) + '</b><span class="small muted">заказ ' + esc(d.num) + ' · ' + nf0.format(d.qty) + ' шт · принят раньше учетного дня, но нет времени доставки — смену не определить</span></div></div>';
    return h + '</div>';
  }

  function renderResults() {
    const el = $('#results');
    if (!S.parsed) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    if (!S.res) { el.innerHTML = '<div class="panel"><div class="empty"><span class="spin"></span> Жду справочник, чтобы посчитать…</div></div>'; return; }
    const r = S.res, m = r.meta;
    let h = unknownBox(r);
    h += '<div class="bar"><div><div class="eyebrow">Результат</div><h2>Учетные дни ' + esc(m.periodLabel) + '</h2></div><button class="btn primary" id="dlBtn">Скачать Excel</button></div>';
    h += '<div class="kpis">' + kpiCard(r.blocks[E.BLOCK_MAIN], E.BLOCK_MAIN, 'Русские пироги и наборы мини-русских, Лапландский, Лиссабонский, Баноффи пай') +
      kpiCard(r.blocks[E.BLOCK_OTHER], E.BLOCK_OTHER, 'Остальные песочные пироги 24 и 18 см, тарталетки и наборы тарталеток') + '</div>';
    h += '<div class="bar"><div class="seg" role="group" aria-label="Таблица" id="resTabs">' +
      [['positions', 'По позициям'], ['days', 'По дням'], ['excluded', 'Не учтено']].map(([k, l]) => '<button type="button" data-t="' + k + '" aria-pressed="' + (S.tab === k) + '">' + l + '</button>').join('') + '</div>';
    if (S.tab === 'positions') h += '<div class="seg" role="group" aria-label="Блок" id="blockTabs">' + [E.BLOCK_MAIN, E.BLOCK_OTHER].map((b) => '<button type="button" data-b="' + b + '" aria-pressed="' + (S.block === b) + '">' + b + '</button>').join('') + '</div>';
    h += '</div><div class="panel"><div class="scroll">' + (S.tab === 'positions' ? blockTable(r.blocks[S.block]) : S.tab === 'days' ? daysTable(r) : exclTable(r)) + '</div></div>';
    h += '<p class="recon">Строк в выгрузке: ' + nf0.format(m.sourceRows) + ' · в расчёте: ' + nf0.format(r.detail.length) + ' строк заказов' + (m.attributed ? ' · ' + nf0.format(m.attributed) + ' строк введены до оформления доставки и отнесены к её времени' : '') + '. Полная детализация по заказам — в Excel.</p>';
    el.innerHTML = h;
  }

  $('#results').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.t) { S.tab = t.dataset.t; renderResults(); return; }
    if (t.dataset.b) { S.block = t.dataset.b; renderResults(); return; }
    if (t.id === 'dlBtn') { download(t); return; }
    const card = t.closest('.unk'); if (!card || !S.res) return;
    const u = S.res.unknown[+card.dataset.i]; if (!u) return;
    const form = card.querySelector('.form');
    const kind = card.querySelector('.u-kind').value;
    if (t.dataset.act === 'map') {
      const target = card.querySelector('.u-target').value.trim();
      const p = S.dict.positions.find((x) => E.norm(x.name) === E.norm(target));
      if (!p) { toast('Выберите позицию из списка справочника'); return; }
      addDoc('aliases', { name: u.dish, size: u.size || '', target: p.name, kind });
      toast('«' + u.dish + '» → ' + p.name + '. Не забудьте сохранить справочник.');
    } else if (t.dataset.act === 'newpos') {
      form.hidden = false;
      form.innerHTML = '<input class="f-name fld" value="' + esc(u.dish + (u.size ? ' ' + u.size : '')) + '" aria-label="Название позиции" style="flex:2 1 220px">' +
        '<input class="f-group fld" list="dlGroups" placeholder="Группа" aria-label="Группа" value="' + esc(guessGroup(u)) + '" style="flex:1 1 160px">' +
        '<select class="f-block fld" aria-label="Блок"><option>' + E.BLOCK_OTHER + '</option><option>' + E.BLOCK_MAIN + '</option></select>' +
        '<input class="f-weight fld" type="number" min="0" step="1" placeholder="Вес, г" aria-label="Вес одной штуки, г" style="width:100px">' +
        '<button class="btn small primary" data-act="savepos">Добавить позицию</button>';
      form.querySelector('.f-weight').focus();
    } else if (t.dataset.act === 'savepos') {
      const name = form.querySelector('.f-name').value.trim(), group = form.querySelector('.f-group').value.trim();
      const weight = Number(form.querySelector('.f-weight').value);
      if (!name || !group || !(weight > 0)) { toast('Заполните название, группу и вес'); return; }
      const order = Math.max(0, ...S.dict.positions.map((p) => +p.order || 0)) + 1;
      const autoMatch = E.norm(u.dish + (u.size ? ' ' + u.size : '')) === E.norm(name) || E.norm(u.dish) === E.norm(name);
      S.ops.push({ t: 'add', c: 'positions', doc: { id: newId('p'), name, group, block: form.querySelector('.f-block').value, weight, note: 'Добавлено со страницы', order } });
      if (!autoMatch || kind !== E.KIND_SOLO) S.ops.push({ t: 'add', c: 'aliases', doc: { id: newId('a'), name: u.dish, size: u.size || '', target: name, kind } });
      applyDict();
      toast('Позиция «' + name + '» добавлена. Не забудьте сохранить справочник.');
    } else if (t.dataset.act === 'skip') {
      form.hidden = false;
      form.innerHTML = '<input class="f-reason fld" placeholder="Почему не считаем" aria-label="Почему не считаем" style="flex:1 1 260px"><button class="btn small primary" data-act="saveskip">Не считать «' + esc(u.dish) + '»</button>';
      form.querySelector('.f-reason').focus();
    } else if (t.dataset.act === 'saveskip') {
      addDoc('exclusions', { match: 'равно', pattern: u.dish, reason: form.querySelector('.f-reason').value.trim() || 'Не считаем' });
      toast('«' + u.dish + '» больше не считается. Не забудьте сохранить справочник.');
    }
  });
  function guessGroup(u) {
    const n = E.norm(u.dish + ' ' + (u.size || ''));
    if (n.includes('тарталетк')) return 'Тарталетки';
    if (n.includes('18 см')) return 'Пироги 18 см';
    if (n.includes('24 см')) return 'Пироги 24 см';
    return '';
  }

  async function download(btn) {
    if (!S.res) return;
    if (!window.ExcelJS) { toast('Не загрузилась библиотека Excel. Обновите страницу.'); return; }
    const label = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Готовлю файл…';
    try {
      const wb = await E.buildWorkbook(window.ExcelJS, S.res, { fileName: S.fileName, dict: S.dict });
      const buf = await wb.xlsx.writeBuffer();
      const m = S.res.meta;
      let per = m.periodLabel;
      if (m.firstDay && m.lastDay) { const a = E.fmtDay(m.firstDay), b = E.fmtDay(m.lastDay); per = a.slice(6) === b.slice(6) ? a.slice(0, 5) + '–' + b : a + '–' + b; }
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = 'Тоннаж по сменам ' + per + '.xlsx';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    } catch (e) { toast('Не удалось собрать файл: ' + (e.message || e)); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---------- справочник: таблицы ----------
  const DICT_HINT = {
    positions: 'Каждая позиция — то, что реально пекут, с весом одной штуки. Позиция из отчёта находится сама, если её название с размером совпадает с названием здесь («Шведский пирог» + «24 см» → «Шведский пирог 24 см»). Регистр, ё/е, кавычки и латинские буквы-двойники не важны.',
    aliases: 'Нужны, когда название в отчёте не совпадает с позицией: переименованные пироги и строки-модификаторы из наборов («Американский» → Баноффи 24 см, «Средний Украинский» → Украинский 18 см, «Норвежская» → тарталетка). Пустой размер — любой.',
    exclusions: 'Что не считаем совсем. «Содержит» срабатывает на часть названия; несколько слов через «+» — должны быть все («Набор из тарталеток + 9 шт»).',
  };
  const FIELD_LABEL = { name: 'Название', group: 'Группа', block: 'Блок', weight: 'Вес, г', note: 'Откуда вес', size: 'Размер в отчёте', target: 'Позиция', kind: 'Как продано', match: 'Условие', pattern: 'Текст', reason: 'Причина' };
  const WIDE = { name: 'wide', target: 'wide', note: 'wide', pattern: 'wide', group: 'mid', reason: 'wide' };
  function inp(c, id, f, val, extra) {
    return '<input data-c="' + c + '" data-id="' + esc(id) + '" data-f="' + f + '" value="' + esc(val) + '"' + (WIDE[f] ? ' class="' + WIDE[f] + '"' : '') + (extra || '') + ' aria-label="' + FIELD_LABEL[f] + '">';
  }
  function sel(c, id, f, val, opts) {
    return '<select data-c="' + c + '" data-id="' + esc(id) + '" data-f="' + f + '" aria-label="' + FIELD_LABEL[f] + '">' + opts.map((o) => '<option' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
  }
  function delBtn(c, id) { return '<button class="btn small ghost" data-del="' + c + '" data-id="' + esc(id) + '" title="Удалить строку">Удалить</button>'; }

  function renderDict(force) {
    const body = $('#dictBody');
    if (!force && body.contains(document.activeElement) && document.activeElement.matches('input,select')) { S.dictDirty = true; return; }
    S.dictDirty = false;
    $('#dictHint').textContent = DICT_HINT[S.dictTab];
    document.querySelectorAll('#dictTabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === S.dictTab)));
    $('#dlGroups').innerHTML = groupsList().map((g) => '<option value="' + esc(g) + '">').join('');
    $('#dlPositions').innerHTML = S.dict.positions.map((p) => '<option value="' + esc(p.name) + '">').join('');
    if (S.loadError && !S.base) { body.innerHTML = '<div class="empty">' + esc(S.loadError) + '. Проверьте интернет и обновите страницу.</div>'; return; }
    if (!S.base) { body.innerHTML = '<div class="empty"><span class="spin"></span> Загружаю справочник…</div>'; return; }
    const keepScroll = body.scrollTop;
    const f = E.norm(S.filter);
    const match = (...xs) => !f || xs.some((x) => E.norm(x).includes(f));
    let h = '';
    if (S.dictTab === 'positions') {
      const gOrder = new Map(); for (const p of S.dict.positions) gOrder.set(p.group, Math.min(gOrder.has(p.group) ? gOrder.get(p.group) : 1e9, +p.order || 1e9));
      const list = S.dict.positions.filter((p) => match(p.name, p.group, p.note)).sort((a, b) => (gOrder.get(a.group) - gOrder.get(b.group)) || String(a.group).localeCompare(b.group, 'ru') || String(a.name).localeCompare(b.name, 'ru'));
      h = '<table><thead><tr><th>Позиция</th><th>Группа</th><th>Блок</th><th>Вес, г</th><th>Откуда вес</th><th></th></tr></thead><tbody>' +
        '<tr class="add"><td><input id="np-name" class="wide" placeholder="Новая позиция, например «Бразильский пирог 24 см»" aria-label="Новая позиция"></td><td><input id="np-group" class="mid" list="dlGroups" placeholder="Группа" aria-label="Группа"></td><td><select id="np-block" aria-label="Блок"><option>' + E.BLOCK_OTHER + '</option><option>' + E.BLOCK_MAIN + '</option></select></td><td class="w"><input id="np-weight" type="number" min="0" step="1" placeholder="г" aria-label="Вес, г"></td><td><input id="np-note" class="wide" placeholder="Например: Меню-10, «900+-50 гр»" aria-label="Откуда вес"></td><td><button class="btn small primary" id="np-add">Добавить</button></td></tr>';
      for (const p of list) h += '<tr><td>' + inp('positions', p.id, 'name', p.name) + '</td><td>' + inp('positions', p.id, 'group', p.group, ' list="dlGroups"') + '</td><td>' + sel('positions', p.id, 'block', p.block === 'Основные' ? E.BLOCK_MAIN : p.block, [E.BLOCK_MAIN, E.BLOCK_OTHER]) + '</td><td class="w">' + inp('positions', p.id, 'weight', p.weight, ' type="number" min="0" step="1"') + '</td><td>' + inp('positions', p.id, 'note', p.note || '') + '</td><td>' + delBtn('positions', p.id) + '</td></tr>';
    } else if (S.dictTab === 'aliases') {
      const known = new Set(S.dict.positions.map((p) => E.norm(p.name)));
      const list = S.dict.aliases.filter((a) => match(a.name, a.target, a.size)).sort((a, b) => String(a.target).localeCompare(b.target, 'ru') || String(a.name).localeCompare(b.name, 'ru'));
      h = '<table><thead><tr><th>Название в отчёте</th><th>Размер в отчёте</th><th>Считать как позицию</th><th>Как продано</th><th></th></tr></thead><tbody>' +
        '<tr class="add"><td><input id="na-name" class="wide" placeholder="Как в отчёте iiko" aria-label="Название в отчёте"></td><td><input id="na-size" placeholder="любой" aria-label="Размер в отчёте"></td><td><input id="na-target" class="wide" list="dlPositions" placeholder="Позиция из справочника" aria-label="Позиция"></td><td><select id="na-kind" aria-label="Как продано"><option>' + E.KIND_SOLO + '</option><option>' + E.KIND_SET + '</option></select></td><td><button class="btn small primary" id="na-add">Добавить</button></td></tr>';
      for (const a of list) h += '<tr><td>' + inp('aliases', a.id, 'name', a.name) + '</td><td>' + inp('aliases', a.id, 'size', a.size || '', ' placeholder="любой"') + '</td><td>' + inp('aliases', a.id, 'target', a.target, ' list="dlPositions"') + (known.has(E.norm(a.target)) ? '' : '<div class="bad">Такой позиции нет в справочнике</div>') + '</td><td>' + sel('aliases', a.id, 'kind', a.kind || E.KIND_SOLO, [E.KIND_SOLO, E.KIND_SET]) + '</td><td>' + delBtn('aliases', a.id) + '</td></tr>';
    } else {
      const list = S.dict.exclusions.filter((x) => match(x.pattern, x.reason)).sort((a, b) => String(a.reason).localeCompare(b.reason, 'ru') || String(a.pattern).localeCompare(b.pattern, 'ru'));
      h = '<table><thead><tr><th>Название</th><th>Текст</th><th>Причина</th><th></th></tr></thead><tbody>' +
        '<tr class="add"><td><select id="nx-match" aria-label="Условие"><option>содержит</option><option>равно</option></select></td><td><input id="nx-pattern" class="wide" placeholder="Например: Сертификат" aria-label="Текст"></td><td><input id="nx-reason" class="wide" placeholder="Почему не считаем" aria-label="Причина"></td><td><button class="btn small primary" id="nx-add">Добавить</button></td></tr>';
      for (const x of list) h += '<tr><td>' + sel('exclusions', x.id, 'match', x.match, ['содержит', 'равно']) + '</td><td>' + inp('exclusions', x.id, 'pattern', x.pattern) + '</td><td>' + inp('exclusions', x.id, 'reason', x.reason || '') + '</td><td>' + delBtn('exclusions', x.id) + '</td></tr>';
    }
    body.innerHTML = h + '</tbody></table>';
    body.scrollTop = keepScroll;
  }

  $('#dictTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.dictTab = b.dataset.t; renderDict(true); });
  $('#dictFilter').addEventListener('input', (e) => { S.filter = e.target.value; renderDict(true); });
  $('#dictReload').addEventListener('click', async () => {
    if (S.ops.length) { toast('Сначала сохраните или отмените свои правки'); return; }
    await loadDict(); toast('Справочник обновлён');
  });
  const dictBody = $('#dictBody');
  dictBody.addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset || !t.dataset.c) return;
    const f = t.dataset.f;
    let v = t.value;
    if (f === 'weight') { v = Number(v); if (!(v >= 0)) { toast('Вес — число в граммах'); return; } }
    else v = String(v).trim();
    if ((f === 'name' || f === 'target' || f === 'pattern') && !v) { toast('Поле не может быть пустым'); renderDict(true); return; }
    updDoc(t.dataset.c, t.dataset.id, f, v);
  });
  dictBody.addEventListener('focusout', () => setTimeout(() => { if (S.dictDirty && !(dictBody.contains(document.activeElement) && document.activeElement.matches('input,select'))) renderDict(true); }, 0));
  dictBody.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.del) {
      if (!b.classList.contains('danger')) { b.classList.add('danger'); b.textContent = 'Точно удалить?'; setTimeout(() => { if (b.isConnected) { b.classList.remove('danger'); b.textContent = 'Удалить'; } }, 4000); return; }
      delDoc(b.dataset.del, b.dataset.id); return;
    }
    const v = (id) => ($('#' + id).value || '').trim();
    if (b.id === 'np-add') {
      const name = v('np-name'), group = v('np-group'), weight = Number(v('np-weight'));
      if (!name || !group || !(weight > 0)) { toast('Заполните название, группу и вес'); return; }
      if (S.dict.positions.some((p) => E.norm(p.name) === E.norm(name))) { toast('Такая позиция уже есть'); return; }
      addDoc('positions', { name, group, block: $('#np-block').value, weight, note: v('np-note'), order: Math.max(0, ...S.dict.positions.map((p) => +p.order || 0)) + 1 });
      renderDict(true);
    } else if (b.id === 'na-add') {
      const name = v('na-name'), target = v('na-target');
      if (!name || !target) { toast('Заполните название в отчёте и позицию'); return; }
      addDoc('aliases', { name, size: v('na-size'), target, kind: $('#na-kind').value }); renderDict(true);
    } else if (b.id === 'nx-add') {
      const pattern = v('nx-pattern'); if (!pattern) { toast('Заполните текст'); return; }
      addDoc('exclusions', { match: $('#nx-match').value, pattern, reason: v('nx-reason') || 'Не считаем' }); renderDict(true);
    }
  });

  // ---------- статус, правки, токен ----------
  function plural(n, a, b, c) { const m = n % 10, h = n % 100; return n + ' ' + (m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c); }
  function renderChip() {
    const chip = $('#dictChip');
    let dot = '', txt = '';
    if (S.loadError && !S.base) { dot = 'warn'; txt = 'Справочник не загрузился'; }
    else if (!S.base) txt = 'Загружаю справочник…';
    else {
      dot = 'ok';
      txt = 'Справочник: ' + plural(S.dict.positions.length, 'позиция', 'позиции', 'позиций') + ' · ' + plural(S.dict.aliases.length, 'название', 'названия', 'названий') + ' · ' + plural(S.dict.exclusions.length, 'исключение', 'исключения', 'исключений');
      if (S.lastCommit) txt += ' · правка ' + S.lastCommit.date.toLocaleDateString('ru-RU');
      if (S.source === 'site') { dot = 'warn'; txt += ' · копия с сайта'; }
    }
    chip.innerHTML = '<span class="dot ' + dot + '"></span><span>' + esc(txt) + '</span>';
  }
  function renderPending() {
    const bar = $('#pending');
    if (!S.ops.length) { bar.hidden = true; return; }
    bar.hidden = false;
    $('#pendingText').textContent = 'Правки справочника не сохранены: ' + S.ops.length + '. Они уже учтены в этом расчёте, но другие их не увидят.';
    const btn = $('#pendingSave');
    btn.disabled = S.saving;
    btn.innerHTML = S.saving ? '<span class="spin"></span> Сохраняю…' : 'Сохранить в справочник';
  }
  $('#pendingSave').addEventListener('click', saveToGitHub);
  $('#pendingDiscard').addEventListener('click', discardOps);

  function openToken(msg) {
    const p = $('#tokenPanel');
    p.hidden = false;
    $('#tokenMsg').textContent = msg || '';
    $('#tokenState').textContent = getToken() ? 'Токен сохранён в этом браузере.' : 'В этом браузере токена нет.';
    $('#tokenForget').hidden = !getToken();
    $('#tokenInput').value = '';
    p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#tokenInput').focus();
  }
  $('#tokenOpen').addEventListener('click', () => openToken(''));
  $('#tokenClose').addEventListener('click', () => { $('#tokenPanel').hidden = true; });
  $('#tokenForget').addEventListener('click', () => { setToken(''); openToken('Токен удалён из этого браузера.'); });
  $('#tokenSave').addEventListener('click', async () => {
    const t = $('#tokenInput').value.trim();
    if (!t) { toast('Вставьте токен'); return; }
    const btn = $('#tokenSave'); btn.disabled = true;
    try {
      const r = await fetch(API, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + t }, cache: 'no-store' });
      if (r.status === 401) throw new Error('GitHub не принял токен. Проверьте, что скопировали его целиком.');
      if (!r.ok) throw new Error('Токен не видит репозиторий ' + GH.owner + '/' + GH.repo + ' (ответ ' + r.status + '). Проверьте, что выбрали его при создании токена.');
      setToken(t);
      $('#tokenPanel').hidden = true;
      toast('Токен сохранён в этом браузере');
      if (S.ops.length) saveToGitHub();
    } catch (e) { $('#tokenMsg').textContent = e.message || String(e); }
    finally { btn.disabled = false; }
  });

  renderChip(); renderDict(true);
  loadDict();
})();
