'use strict';
/**
 * 管理端回复 / 延迟自动回复（纯逻辑，方便单测）
 * - 自动回复：收到用户微信反馈后 N 分钟，若管理员仍未回复，发引导文案
 * - 文案支持 {studentId} / {content} 占位符
 */

const DEFAULT_AUTO_REPLY_TEMPLATE = [
  '📩 已收到你的消息！管理员会尽快查看并回复。如果着急，可以：',
  '1. 在仪表盘提交留言反馈（处理更快）',
  '2. 加入QQ群（[1107914277]）获取人工帮助。'
].join('\n');

const DEFAULT_DELAY_MINUTES = 10;
const MAX_DELAY_MINUTES = 1440;
const MAX_REPLY_LENGTH = 500;

function normalizeDelayMinutes(value, fallback = DEFAULT_DELAY_MINUTES) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DELAY_MINUTES, Math.max(1, n));
}

/** 收到消息时算出「可以自动回复」的时间点；关闭自动回复返回 null */
function buildAutoReplyDue(now, delayMinutes, enabled = true) {
  if (!enabled) return null;
  const base = now instanceof Date ? now.getTime() : Number(now);
  const minutes = normalizeDelayMinutes(delayMinutes);
  return new Date((Number.isFinite(base) ? base : Date.now()) + minutes * 60 * 1000);
}

function isAutoReplyDue(feedback, now = new Date()) {
  if (!feedback || feedback.replied || feedback.autoReplied) return false;
  if (!feedback.autoReplyDueAt) return false;
  const due = new Date(feedback.autoReplyDueAt).getTime();
  const cur = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(due) && due <= cur;
}

function renderAutoReply(template, feedback) {
  const fb = feedback || {};
  const text = String(template == null || template === '' ? DEFAULT_AUTO_REPLY_TEMPLATE : template);
  return text
    .replace(/\{studentId\}/g, String(fb.studentId || '同学'))
    .replace(/\{content\}/g, String(fb.content || '').slice(0, 50));
}

/** 管理员回复内容清洗：去首尾空白、限制长度；空内容返回 '' */
function sanitizeReplyContent(content, maxLength = MAX_REPLY_LENGTH) {
  return String(content == null ? '' : content).trim().slice(0, maxLength);
}

module.exports = {
  DEFAULT_AUTO_REPLY_TEMPLATE,
  DEFAULT_DELAY_MINUTES,
  MAX_DELAY_MINUTES,
  MAX_REPLY_LENGTH,
  normalizeDelayMinutes,
  buildAutoReplyDue,
  isAutoReplyDue,
  renderAutoReply,
  sanitizeReplyContent
};
