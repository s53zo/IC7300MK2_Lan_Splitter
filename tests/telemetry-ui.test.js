'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../desktop/renderer.js'), 'utf8');
const begin = source.indexOf('function renderTelemetry('), end = source.indexOf('function renderTtls(', begin);
const render = source.slice(begin, end);
class Element {
    constructor(tag, value = '') { this.tag = tag; this.textContent = String(value); this.children = []; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get content() { return this.textContent + this.children.map((child) => child.content).join(' '); }
}
function draw(input, rxTx = 'RX') {
    const nodes = new Map();
    const node = (id) => { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); };
    const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    vm.runInNewContext(render + '\nrenderTelemetry(input);', { input, state: { dashboard: { rxTx } },
        byId: node, text: (id, value) => { node(id).textContent = value; },
        element: (tag, value) => new Element(tag, value), number,
        count: (value) => String(Math.max(0, number(value))), milliseconds: (value) => Number.isFinite(value) ? `${value} ms` : '—' });
    return { node, rows: node('telemetry-rows').children.map((row) => row.content) };
}
const row = (key, properties = {}) => ({ key, intervalMs: key === '1507' ? 500 : 100,
    maxAgeMs: key === '1507' ? 1000 : 300, txOnly: ['1511', '1512', '1513'].includes(key),
    polling: true, sharing: true, fresh: true, sampleAgeMs: 25, rfPolls: 0, localAnswers: 0,
    zeroReplies: 0, fallbacks: 0, backpressureSkips: 0, ...properties });

test('telemetry UI distinguishes scheduled radio cost, local answers, freshness and RX zeros', () => {
    const result = draw({ requested: true, enabled: true, querySettings: [
        row('1c00', { rfPolls: 10, localAnswers: 8 }), row('1502', { rfPolls: 10, localAnswers: 9 }),
        row('1507', { rfPolls: 2, localAnswers: 1, fallbacks: 2 }),
        row('1511', { polling: false, fresh: false, sampleAgeMs: null, localAnswers: 2, zeroReplies: 2 }),
    ] });
    assert.equal(result.node('telemetry-polls').textContent, '22');
    assert.equal(result.node('telemetry-answers').textContent, '20');
    assert.equal(result.node('telemetry-fallbacks').textContent, '2');
    assert.match(result.rows[2], /500 ms.*1000 ms/);
    assert.match(result.rows[3], /RX: zero replies/); assert.match(result.rows[3], /RX state 25 ms/);
});

test('telemetry UI refuses to describe stale RX proof as fresh zero replies', () => {
    const result = draw({ requested: true, enabled: true, querySettings: [
        row('1c00', { fresh: false, sampleAgeMs: 750 }), row('1511', { polling: false, fresh: false, sampleAgeMs: null }),
    ] });
    assert.match(result.rows[0], /750 ms \(stale\)/); assert.match(result.rows[0], /Polling · stale sample/);
    assert.doesNotMatch(result.rows.join(' '), /RX: zero replies/);
    assert.match(result.rows[1], /Waiting for TX state/);
});

test('telemetry UI marks absent and global-disabled status without inventing sampling activity', () => {
    const absent = draw(null); assert.equal(absent.node('telemetry-status').textContent, 'Unavailable');
    assert.equal(absent.node('telemetry-polls').textContent, '—');
    const paused = draw({ requested: true, enabled: false, querySettings: [row('1502', { sharing: false, polling: false })] });
    assert.equal(paused.node('telemetry-status').textContent, 'Paused — cache disabled');
    assert.match(paused.rows[0], /Not shared.*Paused/);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../desktop/index.html'), 'utf8'), /Radio queries avoided|Cache savings|Less work for your radio/);
});
