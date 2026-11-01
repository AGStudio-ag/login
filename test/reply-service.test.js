'use strict';

/**
 * 管理端回复 / 延迟自动回复 纯逻辑单测
 */

const test = require('node:test');
const assert = require('node:assert');
const R = require('../replyService');

test('normalizeDelayMinutes：默认 10，范围 1~1440', () => {
  assert.equal(R.normalizeDelayMinutes(undefined), 10);
  assert.equal(R.normalizeDelayMinutes('abc'), 10);
  assert.equal(R.normalizeDelayMinutes(0), 1);
  assert.equal(R.normalizeDelayMinutes(-5), 1);
  assert.equal(R.normalizeDelayMinutes(30), 30);
  assert.equal(R.normalizeDelayMinutes(99999), 1440);
});

test('buildAutoReplyDue：按分钟延后；关闭时返回 null', () => {
  const now = new Date('2026-11-02T04:00:00Z');
  const due = R.buildAutoReplyDue(now, 10, true);
  assert.equal(due.toISOString(), '2026-11-02T04:10:00.000Z');
  assert.equal(R.buildAutoReplyDue(now, 10, false), null);
  assert.equal(R.buildAutoReplyDue(now, 1, true).getTime() - now.getTime(), 60000);
});

test('isAutoReplyDue：到期且未回复/未自动回复才为 true', () => {
  const now = new Date('2026-11-02T04:10:00Z');
  const base = { uid: 'UID_X', replied: false, autoReplied: false, autoReplyDueAt: new Date('2026-11-02T04:09:00Z') };
  assert.equal(R.isAutoReplyDue(base, now), true);
  assert.equal(R.isAutoReplyDue({ ...base, autoReplyDueAt: new Date('2026-11-02T04:11:00Z') }, now), false);
  assert.equal(R.isAutoReplyDue({ ...base, replied: true }, now), false);
  assert.equal(R.isAutoReplyDue({ ...base, autoReplied: true }, now), false);
  assert.equal(R.isAutoReplyDue({ ...base, autoReplyDueAt: null }, now), false);
  assert.equal(R.isAutoReplyDue(null, now), false);
});

test('renderAutoReply：替换 {studentId}/{content}，空模板用默认文案', () => {
  const fb = { studentId: '229144004', content: '签到一直失败' };
  const out = R.renderAutoReply('学号 {studentId}：收到「{content}」', fb);
  assert.equal(out, '学号 229144004：收到「签到一直失败」');

  const fallback = R.renderAutoReply('', fb);
  assert.ok(fallback.includes('您的反馈已收到'));
  assert.equal(R.renderAutoReply('固定文案', { studentId: '', content: '' }), '固定文案');
});

test('renderAutoReply：超长原始内容只截 50 字', () => {
  const fb = { studentId: '1', content: 'x'.repeat(200) };
  const out = R.renderAutoReply('{content}', fb);
  assert.equal(out.length, 50);
});

test('sanitizeReplyContent：去空白、限长、空串', () => {
  assert.equal(R.sanitizeReplyContent('  hi  '), 'hi');
  assert.equal(R.sanitizeReplyContent(''), '');
  assert.equal(R.sanitizeReplyContent(null), '');
  assert.equal(R.sanitizeReplyContent('x'.repeat(600)).length, 500);
});
