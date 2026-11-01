'use strict';

/**
 * 通知偏好纯逻辑单测（HANDOFF §16）
 * 重点：failure_only/always × 微信/邮件 × 成功/失败 的完整矩阵，以及旧默认兼容。
 */

const test = require('node:test');
const assert = require('node:assert');
const P = require('../notificationPrefs');

const boundVip = {
  studentId: '229144004',
  wxpusherUid: 'UID_8K9sa7test',
  email: 'u@example.com',
  emailVerified: true,
  isVip: true,
  vipExpireAt: new Date(Date.now() + 86400000),
  notifyChannels: ['wechat', 'email'],
  notifyLevel: 'failure_only'
};

test('normalizeChannels：只认 wechat/email，去重并按「先微信后邮件」固定顺序', () => {
  assert.deepEqual(P.normalizeChannels(['email', 'wechat']), ['wechat', 'email']);
  assert.deepEqual(P.normalizeChannels(['EMAIL', ' wechat ', 'email']), ['wechat', 'email']);
  assert.deepEqual(P.normalizeChannels(['sms', 'wechat']), ['wechat']);
  assert.deepEqual(P.normalizeChannels([]), []);
  assert.deepEqual(P.normalizeChannels(null), []);
  assert.deepEqual(P.normalizeChannels('wechat'), []);
});

test('normalizeLevel：非法值回落 failure_only', () => {
  assert.equal(P.normalizeLevel('always'), 'always');
  assert.equal(P.normalizeLevel('ALWAYS'), 'always');
  assert.equal(P.normalizeLevel('failure_only'), 'failure_only');
  assert.equal(P.normalizeLevel('sometimes'), 'failure_only');
  assert.equal(P.normalizeLevel(undefined), 'failure_only');
});

test('旧默认：已绑微信默认微信；已验证邮箱的会员再默认邮件', () => {
  const wxOnly = P.resolveNotifySettings({ wxpusherUid: 'UID_1' });
  assert.equal(wxOnly.configured, false);
  assert.deepEqual(wxOnly.channels, ['wechat']);
  assert.equal(wxOnly.level, 'failure_only');

  const wxAndMail = P.resolveNotifySettings({ wxpusherUid: 'UID_1', emailVerified: true, email: 'a@b.c', isVip: true });
  assert.deepEqual(wxAndMail.channels, ['wechat', 'email']);

  const mailOnly = P.resolveNotifySettings({ emailVerified: true, email: 'a@b.c', signCredits: 3 });
  assert.deepEqual(mailOnly.channels, ['email']);

  const none = P.resolveNotifySettings({});
  assert.deepEqual(none.channels, []);
  assert.deepEqual(none.available, { wechat: false, email: false });
});

test('显式空数组 = 用户主动全关（不能被旧默认覆盖）', () => {
  const s = P.resolveNotifySettings({ wxpusherUid: 'UID_1', notifyChannels: [] });
  assert.equal(s.configured, true);
  assert.deepEqual(s.channels, []);
});

test('矩阵：failure_only 时成功一律不发，失败按渠道发', () => {
  const user = { ...boundVip, notifyChannels: ['wechat', 'email'], notifyLevel: 'failure_only' };

  const success = P.buildNotificationPlan(user, true);
  assert.equal(success.send, false);
  assert.equal(success.reason, 'failure_only_skip_success');

  const failure = P.buildNotificationPlan(user, false);
  assert.equal(failure.send, true);
  assert.deepEqual(failure.channels, ['wechat', 'email']);
  assert.equal(failure.emailFallback, true);
  assert.equal(failure.reason, 'failure');
});

test('矩阵：always 时成功也按渠道发', () => {
  const user = { ...boundVip, notifyChannels: ['wechat'], notifyLevel: 'always' };
  const success = P.buildNotificationPlan(user, true);
  assert.equal(success.send, true);
  assert.equal(success.reason, 'always_success');
  assert.deepEqual(success.channels, ['wechat']);
  assert.equal(success.emailFallback, false);
});

test('矩阵：只开邮件时成功/失败都走邮件，且不产生「微信兜底」标记', () => {
  const user = { ...boundVip, notifyChannels: ['email'], notifyLevel: 'always' };
  for (const ok of [true, false]) {
    const plan = P.buildNotificationPlan(user, ok);
    assert.equal(plan.send, true, 'success=' + ok);
    assert.deepEqual(plan.channels, ['email']);
    assert.equal(plan.emailFallback, false);
  }
});

test('矩阵：全关（空数组）时成功失败都不发', () => {
  const user = { ...boundVip, notifyChannels: [], notifyLevel: 'always' };
  for (const ok of [true, false]) {
    const plan = P.buildNotificationPlan(user, ok);
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'no_channels');
  }
});

test('矩阵：选了不可用的渠道 → 过滤掉；全不可用 → channel_unavailable', () => {
  const unverified = { ...boundVip, emailVerified: false, notifyChannels: ['wechat', 'email'] };
  const plan = P.buildNotificationPlan(unverified, false);
  assert.equal(plan.send, true);
  assert.deepEqual(plan.channels, ['wechat']);
  assert.deepEqual(plan.unavailableChannels, ['email']);

  const noChannel = P.buildNotificationPlan({ ...boundVip, emailVerified: false, wxpusherUid: '', notifyChannels: ['wechat', 'email'], notifyLevel: 'always' }, true);
  assert.equal(noChannel.send, false);
  assert.equal(noChannel.reason, 'channel_unavailable');
});

test('矩阵覆盖参数（后台 wx-test 用）：只影响本次判定，不改用户设置', () => {
  const user = { ...boundVip, notifyChannels: ['wechat'], notifyLevel: 'failure_only' };
  const override = P.buildNotificationPlan(user, true, { level: 'always', channels: ['email'] });
  assert.equal(override.send, true);
  assert.deepEqual(override.channels, ['email']);
  // 用户原偏好不变
  const base = P.buildNotificationPlan(user, true);
  assert.equal(base.send, false);
  assert.deepEqual(base.requestedChannels, ['wechat']);
});

test('保存校验：渠道白名单 / 微信未绑 / 邮箱未验证 / 允许空数组', () => {
  const user = { wxpusherUid: '', emailVerified: false, email: '' };
  assert.equal(P.validateSettingsPayload({ channels: ['sms'], level: 'always' }, user).ok, false);
  assert.equal(P.validateSettingsPayload({ channels: 'wechat' }, user).ok, false);
  assert.equal(P.validateSettingsPayload({ channels: ['wechat'] }, user).ok, false);
  assert.equal(P.validateSettingsPayload({ channels: ['email'] }, user).ok, false);
  assert.equal(P.validateSettingsPayload({ level: 'sometimes' }, user).ok, false);

  const okEmpty = P.validateSettingsPayload({ channels: [], level: 'always' }, user);
  assert.equal(okEmpty.ok, true);
  assert.deepEqual(okEmpty.channels, []);
  assert.equal(okEmpty.level, 'always');

  const bound = { wxpusherUid: 'UID_1', emailVerified: true, email: 'a@b.c' };
  const okBoth = P.validateSettingsPayload({ channels: ['email', 'wechat'] }, bound);
  assert.equal(okBoth.ok, true);
  assert.deepEqual(okBoth.channels, ['wechat', 'email']);
});

test('describePlan 给出人话说明（后台测试结果直接展示）', () => {
  const plan = P.buildNotificationPlan({ ...boundVip, notifyLevel: 'always' }, true);
  assert.match(P.describePlan(plan), /总是通知/);
  assert.match(P.describePlan(plan), /微信 → 邮件/);
  const skip = P.buildNotificationPlan({ ...boundVip, notifyLevel: 'failure_only' }, true);
  assert.match(P.describePlan(skip), /成功时不发/);
});
