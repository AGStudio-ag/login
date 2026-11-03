'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { batchTimeoutMs, createRunLock } = require('../autoSignRuntime');

test('批次超时：30s 固定 + 每人 20s，最低 90s', () => {
  assert.equal(batchTimeoutMs(1), 90000);
  assert.equal(batchTimeoutMs(3), 90000);
  assert.equal(batchTimeoutMs(4), 110000);
  assert.equal(batchTimeoutMs(5), 130000);
  assert.equal(batchTimeoutMs(10), 230000);
});

test('批次超时：人数缺失/非法按 1 人处理，不会返回 0 或负数', () => {
  assert.equal(batchTimeoutMs(0), 90000);
  assert.equal(batchTimeoutMs(-5), 90000);
  assert.equal(batchTimeoutMs('abc'), 90000);
  assert.equal(batchTimeoutMs(undefined), 90000);
});

test('运行锁：同一时间只允许一个任务，重复触发返回已运行秒数', () => {
  let now = 1_000_000;
  const lock = createRunLock(() => now);
  assert.equal(lock.current, null);

  const first = lock.tryStart('21:35');
  assert.equal(first.ok, true);
  assert.equal(lock.current.targetTime, '21:35');

  now += 125_000;
  const second = lock.tryStart('21:55');
  assert.equal(second.ok, false);
  assert.equal(second.runningFor, 125);
  assert.equal(lock.current.targetTime, '21:35', '第二个任务不能覆盖当前任务');

  lock.finish();
  assert.equal(lock.current, null);

  now += 1_000;
  const third = lock.tryStart('21:55');
  assert.equal(third.ok, true);
  assert.equal(lock.current.targetTime, '21:55');
});

test('运行锁：finish 只释放当前锁，释放后可重新开始', () => {
  const lock = createRunLock(() => 5_000);
  assert.equal(lock.tryStart('').ok, true);
  assert.equal(lock.current.targetTime, null, '空 targetTime 统一存 null');
  lock.finish();
  assert.equal(lock.tryStart('21:35').ok, true);
});
