import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTestMode } from '../scripts/test.mjs';

const denied = async () => ({ available: false, reason: 'EACCES' });
const allowed = async () => ({ available: true });

test('test runner automatically uses sockets when the capability check passes', async () => {
  const result = await selectTestMode({ probe: allowed });
  assert.equal(result.mode, 'network');
  assert.match(result.reason, /probe passed/);
});

test('test runner reports permission denial and selects portable fixtures locally', async () => {
  const result = await selectTestMode({ probe: denied });
  assert.equal(result.mode, 'in-process');
  assert.match(result.reason, /EACCES/);
});

test('network and CI runs fail rather than silently skipping denied socket checks', async () => {
  await assert.rejects(selectTestMode({ mode: 'network', probe: denied }), /require loopback access/);
  await assert.rejects(selectTestMode({ mode: 'network', probe: denied }), /EACCES/);
  await assert.rejects(selectTestMode({ ci: true, probe: denied }), /require loopback access/);
  assert.equal((await selectTestMode({ ci: true, probe: allowed })).mode, 'network');
});

test('explicit portable mode does not probe or require network access', async () => {
  let probed = false;
  const result = await selectTestMode({ mode: 'in-process', probe: async () => { probed = true; } });
  assert.equal(result.mode, 'in-process');
  assert.equal(probed, false);
  assert.equal(result.reason, 'explicitly requested');
});

test('test runner does not reinterpret unexpected probe failures as permission restrictions', async () => {
  const error = new Error('Unexpected probe failure');
  await assert.rejects(selectTestMode({ probe: async () => { throw error; } }), value => value === error);
  await assert.rejects(selectTestMode({ mode: 'unknown' }), /Unknown test mode/);
});
