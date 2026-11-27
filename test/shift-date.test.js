const test = require('node:test');
const assert = require('node:assert/strict');
const { compute, fmtDay, BLOCK_MAIN } = require('../engine');

const dict = { positions: [{ name: 'Пирог', weight: 500, block: BLOCK_MAIN }] };

function order(day, opened, deliveryTime, qty = 1) {
  return {
    day: new Date(day + 'T00:00:00Z'),
    open: new Date(opened + 'T06:00:00Z'),
    dlv: deliveryTime ? new Date(day + 'T' + deliveryTime + 'Z') : null,
    dish: 'Пирог', qty,
  };
}

test('Ночь группируется по началу смены, исходные даты и правило 12:00 сохраняются', () => {
  const rows = [
    order('2026-11-22', '2026-11-22', '08:00', 4),
    order('2026-11-23', '2026-11-19', '11:59', 2),
    order('2026-11-23', '2026-11-19', '12:00', 3),
    order('2026-11-23', '2026-11-23', '08:00'),
    order('2026-11-23', '2026-11-20', null),
  ];
  const result = compute({ rows }, dict);
  assert.deepEqual(result.byDay.map(r => [fmtDay(r.day), r.mainDay, r.mainNight]), [
    ['22.11.2026', 2, 1], ['23.11.2026', 2, 0],
  ]);
  const night = result.detail.find(d => d.shift === 'Ночь');
  assert.equal(fmtDay(night.day), '23.11.2026');
  assert.equal(fmtDay(night.shiftDay), '22.11.2026');
  assert.equal(result.noShift.length, 1);
});

test('Ночь первого числа попадает в предыдущий месяц, в том числе на границах года и високосного февраля', () => {
  for (const [day, previous, expected] of [
    ['2026-11-01', '2026-10-31', '31.10.2026'],
    ['2027-01-01', '2026-12-31', '31.12.2026'],
    ['2028-03-01', '2028-02-29', '29.02.2028'],
  ]) {
    const result = compute({ rows: [order(day, previous, '10:00')] }, dict);
    assert.equal(result.byDay.length, 1);
    assert.equal(fmtDay(result.byDay[0].day), expected);
    assert.equal(result.byDay[0].mainNight, 0.5);
  }
});
