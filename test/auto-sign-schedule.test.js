'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isSubscriptionDueToday } = require('../autoSignSchedule');

const base = {
  subTime: '21:35',
  planTime: '21:35',
  scheduleType: 'daily',
  customDays: [0, 1, 2, 3, 4, 5, 6],
  dayOfWeek: 2,
  isCustomTimeRun: false,
  canCustomTime: false
};

test('默认 21:35 批次：无自定义时间权限的 TERM 用户也要签到', () => {
  assert.equal(isSubscriptionDueToday(base), true);
  assert.equal(isSubscriptionDueToday({ ...base, canCustomTime: false, isCustomTimeRun: false }), true);
});

test('自定义时间批次：无自定义时间权限的用户被排除', () => {
  assert.equal(isSubscriptionDueToday({ ...base, isCustomTimeRun: true, canCustomTime: false }), false);
  assert.equal(isSubscriptionDueToday({ ...base, isCustomTimeRun: true, canCustomTime: true }), true);
});

test('签到时间不匹配：任何批次都不执行', () => {
  assert.equal(isSubscriptionDueToday({ ...base, subTime: '22:00' }), false);
  assert.equal(isSubscriptionDueToday({ ...base, subTime: '22:00', isCustomTimeRun: true, canCustomTime: true }), false);
});

test('weekdays：周日不签，周一到周五签', () => {
  const sub = { ...base, scheduleType: 'weekdays' };
  assert.equal(isSubscriptionDueToday({ ...sub, dayOfWeek: 0 }), false);
  assert.equal(isSubscriptionDueToday({ ...sub, dayOfWeek: 1 }), true);
  assert.equal(isSubscriptionDueToday({ ...sub, dayOfWeek: 5 }), true);
  assert.equal(isSubscriptionDueToday({ ...sub, dayOfWeek: 6 }), false);
});

test('custom：按 customDays 匹配（兼容字符串数字）', () => {
  const sub = { ...base, scheduleType: 'custom', customDays: ['1', '3', '5'] };
  assert.equal(isSubscriptionDueToday({ ...sub, dayOfWeek: 3 }), true);
  assert.equal(isSubscriptionDueToday({ ...sub, dayOfWeek: 2 }), false);
});

test('daily：每天执行（含周末）', () => {
  assert.equal(isSubscriptionDueToday({ ...base, dayOfWeek: 0 }), true);
  assert.equal(isSubscriptionDueToday({ ...base, dayOfWeek: 6 }), true);
});

test('未知 scheduleType / 缺参数：不执行', () => {
  assert.equal(isSubscriptionDueToday({ ...base, scheduleType: 'weekly' }), false);
  assert.equal(isSubscriptionDueToday({ ...base, subTime: '' }), false);
  assert.equal(isSubscriptionDueToday({ ...base, planTime: '' }), false);
});
