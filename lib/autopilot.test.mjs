import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleDates, cycleSlots } from './autopilot.ts';

test('first cycle starts tomorrow in Colombia and contains 15 full dates', () => {
  const cycle = cycleDates(Date.parse('2026-10-03T02:00:00Z'));
  assert.deepEqual(cycle, { start: '2026-10-03', end: '2026-10-17' });
  const slots = cycleSlots(cycle.start, '[0,1,2,3,4,5,6]', '18:00', '09:00', true);
  assert.equal(slots.length, 30);
  assert.equal(slots[0].scheduledAt, '2026-10-03T14:00:00.000Z');
  assert.equal(slots.at(-1).scheduledAt, '2026-10-17T23:00:00.000Z');
  assert.equal(new Set(slots.map(s => s.date + s.mediaType)).size, 30);
});
test('renews two days before end without gaps across year boundary', () => {
  assert.equal(cycleDates(Date.parse('2026-12-29T12:00:00Z'), '2027-01-01'), null);
  assert.deepEqual(cycleDates(Date.parse('2026-12-30T12:00:00Z'), '2027-01-01'), {start:'2027-01-02',end:'2027-01-16'});
});
test('honors selected days, story switch, and rejects invalid times', () => {
  assert.equal(cycleSlots('2026-10-03', '[1]', '18:00', '09:00', false).length, 2);
  assert.equal(cycleSlots('2026-10-03', '[0,1,2,3,4,5,6]', '28:00', '09:00', true).length, 0);
});
