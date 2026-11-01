'use strict';
/**
 * 签到结果通知偏好（HANDOFF §16）——纯逻辑，不依赖 mongoose / express，方便单测。
 *
 * 约定：
 * - `notifyChannels` 未设置（undefined / null）=> 沿用重构前的默认行为，configured=false：
 *     绑了微信 → ['wechat']；同时是「已验证邮箱的会员 / 有次数卡」→ 再加 'email'
 *   （重构前：微信推给所有绑定者，邮件只发给 emailVerified 的会员/次数卡用户）
 * - `notifyChannels` 是数组（含空数组 []）=> 用户自己选过，[] 表示「全部关闭」
 * - `notifyLevel`: 'failure_only'（默认，仅失败时发）/ 'always'（成功失败都发）
 * - 渠道顺序固定：先微信，微信失败/不可用时才用邮件兜底（省 Resend 额度）
 */

const CHANNELS = Object.freeze(['wechat', 'email']);
const LEVELS = Object.freeze(['failure_only', 'always']);
const DEFAULT_LEVEL = 'failure_only';
const CHANNEL_LABELS = Object.freeze({ wechat: '微信', email: '邮件' });

function normalizeChannels(input) {
  if (!Array.isArray(input)) return [];
  const picked = new Set();
  for (const raw of input) {
    const c = String(raw == null ? '' : raw).trim().toLowerCase();
    if (CHANNELS.includes(c)) picked.add(c);
  }
  // 固定顺序，便于前端/后台稳定展示
  return CHANNELS.filter(c => picked.has(c));
}

function normalizeLevel(input) {
  const v = String(input == null ? '' : input).trim().toLowerCase();
  return LEVELS.includes(v) ? v : DEFAULT_LEVEL;
}

function isConfigured(user) {
  return !!user && Array.isArray(user.notifyChannels);
}

/** 每个渠道在这台账号上是否真的能用 */
function availableChannels(user) {
  const u = user || {};
  return {
    wechat: !!u.wxpusherUid,
    email: !!(u.emailVerified && u.email)
  };
}

/** 重构前的隐式默认（只读，不落库） */
function legacyChannels(user) {
  const u = user || {};
  const avail = availableChannels(u);
  const out = [];
  if (avail.wechat) out.push('wechat');
  // 老逻辑：邮件只发给「会员或次数卡」且邮箱已验证的用户
  const paid = !!u.isVip || Number(u.signCredits || 0) > 0;
  if (avail.email && paid) out.push('email');
  return out;
}

/**
 * 把用户文档解析成前端/后台可直接展示的偏好。
 * 返回的 channels 已包含旧默认兜底（configured=false 时由 legacyChannels 推导）。
 */
function resolveNotifySettings(user) {
  const u = user || {};
  const api = availableChannels(u);
  return {
    channels: isConfigured(u) ? normalizeChannels(u.notifyChannels) : legacyChannels(u),
    level: normalizeLevel(u.notifyLevel),
    configured: isConfigured(u),
    updatedAt: u.notifyUpdatedAt || null,
    available: api,
    email: u.email || '',
    emailVerified: api.email,
    wxpusherBound: api.wechat
  };
}

/** 保存前校验：返回 { ok, channels, level, message } */
function validateSettingsPayload(body, user) {
  const b = body || {};
  const channels = normalizeChannels(b.channels);
  if (Array.isArray(b.channels) && b.channels.length !== channels.length) {
    return { ok: false, message: '通知渠道只能是 wechat / email' };
  }
  if (b.channels !== undefined && !Array.isArray(b.channels)) {
    return { ok: false, message: '通知渠道格式不对（需要数组）' };
  }
  if (b.level !== undefined && !LEVELS.includes(String(b.level))) {
    return { ok: false, message: '通知时机只能是 failure_only / always' };
  }
  const avail = availableChannels(user);
  if (channels.includes('wechat') && !avail.wechat) {
    return { ok: false, message: '请先绑定微信，再开启微信通知' };
  }
  if (channels.includes('email') && !avail.email) {
    return { ok: false, message: '请先绑定并验证邮箱，再开启邮件通知' };
  }
  return { ok: true, channels, level: normalizeLevel(b.level) };
}

/**
 * 分发矩阵：决定这次签到结果「发不发、发哪些渠道」。
 * @param {object} user 用户文档（或 lean 对象）
 * @param {boolean} success 签到是否成功
 * @param {{level?:string, channels?:string[]}} [overrides] 仅后台测试用，不落库
 * @returns {{send:boolean, reason:string, success:boolean, level:string,
 *            requestedChannels:string[], channels:string[], unavailableChannels:string[],
 *            emailFallback:boolean}}
 */
function buildNotificationPlan(user, success, overrides) {
  const base = resolveNotifySettings(user);
  const o = overrides || {};
  const level = o.level !== undefined ? normalizeLevel(o.level) : base.level;
  const requested = o.channels !== undefined ? normalizeChannels(o.channels) : base.channels;
  const plan = {
    send: false,
    reason: '',
    success: !!success,
    level,
    requestedChannels: requested,
    channels: [],
    unavailableChannels: [],
    emailFallback: false
  };

  // 仅失败时机：成功一律不发（这是默认，也是省额度的关键）
  if (success && level !== 'always') { plan.reason = 'failure_only_skip_success'; return plan; }
  if (!requested.length) { plan.reason = 'no_channels'; return plan; }

  plan.unavailableChannels = requested.filter(c => !base.available[c]);
  plan.channels = requested.filter(c => base.available[c]);
  if (!plan.channels.length) { plan.reason = 'channel_unavailable'; return plan; }

  plan.send = true;
  plan.reason = success ? 'always_success' : 'failure';
  // 同时开了微信和邮件时，邮件只在微信失败后兜底
  plan.emailFallback = plan.channels.includes('wechat') && plan.channels.includes('email');
  return plan;
}

/** 人话描述，用于后台测试结果 / 日志 */
function describePlan(plan) {
  if (!plan) return '';
  const when = plan.success ? '成功' : '失败';
  const levelText = plan.level === 'always' ? '总是通知' : '仅失败时通知';
  if (plan.send) {
    const ch = plan.channels.map(c => CHANNEL_LABELS[c]).join(' → ');
    return `${levelText} + ${when} → 发送（${ch}${plan.emailFallback ? '，微信失败才发邮件' : ''}）`;
  }
  const reasons = {
    failure_only_skip_success: '成功时不发（仅失败时机）',
    no_channels: '没有开启任何渠道',
    channel_unavailable: '所选渠道当前不可用（未绑定微信 / 邮箱未验证）'
  };
  return `${levelText} + ${when} → 不发送（${reasons[plan.reason] || plan.reason}）`;
}

module.exports = {
  CHANNELS,
  LEVELS,
  DEFAULT_LEVEL,
  CHANNEL_LABELS,
  normalizeChannels,
  normalizeLevel,
  availableChannels,
  legacyChannels,
  resolveNotifySettings,
  validateSettingsPayload,
  buildNotificationPlan,
  describePlan
};
