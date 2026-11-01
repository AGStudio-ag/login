'use strict';

/**
 * AG 会员套餐单一配置源（2026-11 七套餐体系）
 *
 * 设计原则：
 * 1. 套餐（plan）、会员等级（tier）、功能权限（如自定义时间）是三个不同概念。
 * 2. 业务代码只认稳定的 code / tier，不拿中文名称做判断。
 * 3. 旧等级 VIP / SVIP / LEGACY 只保留兼容用途，不再作为在售套餐。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// 等级常量（user.vipTier 的合法值）
const TIERS = {
  FREE: 'FREE',
  MONTHLY: 'MONTHLY',
  TERM: 'TERM',
  YEARLY: 'YEARLY',
  YEARLY_PRO: 'YEARLY_PRO',
  FRESHMAN: 'FRESHMAN',
  SOPHOMORE: 'SOPHOMORE',
  JUNIOR: 'JUNIOR',
  // 历史等级：只用于兼容旧用户 / 旧订单，不再售卖
  VIP: 'VIP',
  SVIP: 'SVIP',
  LEGACY: 'LEGACY'
};

const TIER_VALUES = Object.values(TIERS);

/**
 * 七种在售套餐。
 * kind: days  = 固定天数
 *       grade = 至毕业（受毕业日期与年级年限双重约束）
 */
const PLANS = [
  {
    code: 'monthly',
    packageId: 'monthly',
    tier: TIERS.MONTHLY,
    group: 'basic',
    name: '月卡',
    alias: '月卡',
    price: 6.66,
    pricePerYear: null,
    kind: 'days',
    days: 30,
    years: 0,
    customTime: false,
    audience: '不限',
    badge: '轻量体验',
    durationLabel: '30 天',
    description: '30 天会员，适合短期使用',
    sort: 1
  },
  {
    code: 'term',
    packageId: 'term',
    tier: TIERS.TERM,
    group: 'basic',
    name: '学期卡',
    alias: '学期卡',
    price: 9.99,
    pricePerYear: null,
    kind: 'days',
    days: 120,
    years: 0,
    customTime: false,
    audience: '不限',
    badge: '性价比',
    durationLabel: '一学期（120 天）',
    description: '一学期会员，覆盖整个学期',
    sort: 2
  },
  {
    code: 'yearly',
    packageId: 'yearly',
    tier: TIERS.YEARLY,
    group: 'basic',
    name: '学年卡',
    alias: '学年卡',
    price: 15.01,
    pricePerYear: 15.01,
    kind: 'days',
    days: 365,
    years: 0,
    customTime: false,
    audience: '不限',
    badge: '最划算',
    durationLabel: '一学年（365 天）',
    description: '一学年会员，长期使用更省心',
    sort: 3
  },
  {
    code: 'yearly_pro',
    packageId: 'yearly_pro',
    tier: TIERS.YEARLY_PRO,
    group: 'pro',
    name: '学年卡 Pro',
    alias: 'Pro',
    price: 20.0,
    pricePerYear: 20.0,
    kind: 'days',
    days: 365,
    years: 0,
    customTime: true,
    audience: '不限',
    badge: '支持自定义时间',
    durationLabel: '一学年（365 天）',
    description: '标准学年权益，额外支持自定义会员时间',
    sort: 4
  },
  {
    code: 'freshman',
    packageId: 'freshman',
    tier: TIERS.FRESHMAN,
    group: 'grade',
    name: '大一学年卡（启航卡）',
    alias: '启航卡',
    price: 49.9,
    pricePerYear: 12.48,
    kind: 'grade',
    days: 0,
    years: 4,
    customTime: true,
    audience: '大一',
    badge: '至毕业',
    durationLabel: '至毕业（约 4 年）',
    description: '从大一开始，安心使用至毕业',
    sort: 5
  },
  {
    code: 'sophomore',
    packageId: 'sophomore',
    tier: TIERS.SOPHOMORE,
    group: 'grade',
    name: '大二学年卡（续航卡）',
    alias: '续航卡',
    price: 39.9,
    pricePerYear: 13.3,
    kind: 'grade',
    days: 0,
    years: 3,
    customTime: true,
    audience: '大二',
    badge: '至毕业',
    durationLabel: '至毕业（约 3 年）',
    description: '从大二开始，持续陪伴至毕业',
    sort: 6
  },
  {
    code: 'junior',
    packageId: 'junior',
    tier: TIERS.JUNIOR,
    group: 'grade',
    name: '大三学年卡（冲刺卡）',
    alias: '冲刺卡',
    price: 28.8,
    pricePerYear: 14.4,
    kind: 'grade',
    days: 0,
    years: 2,
    customTime: true,
    audience: '大三',
    badge: '至毕业',
    durationLabel: '至毕业（约 2 年）',
    description: '为大三准备的毕业前长期使用方案',
    sort: 7
  }
];

const PLAN_BY_CODE = Object.create(null);
const PLAN_BY_TIER = Object.create(null);
PLANS.forEach((plan) => {
  PLAN_BY_CODE[plan.code] = plan;
  PLAN_BY_CODE[plan.packageId] = plan;
  PLAN_BY_TIER[plan.tier] = plan;
});

// 等级权重：仅用于“升级不降级”的判断
const TIER_RANK = {
  FREE: 0,
  MONTHLY: 1,
  TERM: 2,
  YEARLY: 3,
  YEARLY_PRO: 4,
  FRESHMAN: 4,
  SOPHOMORE: 4,
  JUNIOR: 4,
  VIP: 4,
  SVIP: 5,
  LEGACY: 5
};

// 允许自定义签到时间 / 自定义会员时间的等级
const CUSTOM_TIME_TIERS = ['YEARLY_PRO', 'FRESHMAN', 'SOPHOMORE', 'JUNIOR', 'VIP', 'SVIP', 'LEGACY'];

// 历史等级显示名（不允许使用“毕业卡”等旧套餐名）
const LEGACY_TIER_LABELS = {
  FREE: '免费',
  VIP: '学年卡 Pro',
  SVIP: '长期会员（至毕业）',
  LEGACY: '元老会员'
};

const TIER_LABELS = {
  FREE: '免费',
  MONTHLY: '月卡',
  TERM: '学期卡',
  YEARLY: '学年卡',
  YEARLY_PRO: '学年卡 Pro',
  FRESHMAN: '大一学年卡（启航卡）',
  SOPHOMORE: '大二学年卡（续航卡）',
  JUNIOR: '大三学年卡（冲刺卡）',
  VIP: '学年卡 Pro',
  SVIP: '长期会员（至毕业）',
  LEGACY: '元老会员'
};

/** 旧 VIP 统一映射为学年卡 Pro，其余原样返回 */
function normalizeTier(tier) {
  if (!tier) return TIERS.FREE;
  const value = String(tier).toUpperCase();
  if (value === TIERS.VIP) return TIERS.YEARLY_PRO;
  return TIER_VALUES.includes(value) ? value : TIERS.FREE;
}

function planForTier(tier) {
  return PLAN_BY_TIER[normalizeTier(tier)] || null;
}

function planForCode(code) {
  if (!code) return null;
  return PLAN_BY_CODE[String(code)] || PLAN_BY_CODE[String(code).toLowerCase()] || null;
}

/**
 * 管理后台用的套餐元数据：唯一形状，后端两处（/api/admin/tier-meta 与赞助订单 needPlan 分支）共用。
 * 字段刻意保持最小集，前端只依赖这几项：code / name / price / kind / days / durationLabel。
 * 顺序按 plan.sort，管理后台的套餐编号就是这里的顺序，不要重排。
 */
function planMetaList() {
  return PLANS.slice()
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .map(p => ({
      code: p.code,
      name: p.name,
      price: p.price,
      kind: p.kind,
      days: p.days,
      durationLabel: p.durationLabel || ''
    }));
}

function tierLabel(tier) {
  const normalized = normalizeTier(tier);
  return TIER_LABELS[normalized] || LEGACY_TIER_LABELS[normalized] || '会员';
}

function tierRank(tier) {
  const normalized = normalizeTier(tier);
  return TIER_RANK[normalized] !== undefined ? TIER_RANK[normalized] : 0;
}

/** 所有“支持自定义时间”的等级（含历史等级） */
function tierAllowsCustomTime(tier) {
  return CUSTOM_TIME_TIERS.includes(normalizeTier(tier));
}

/**
 * 统一权益判断：会员有效 + 等级支持自定义时间。
 * 会员有效期判断由调用方传入 hasActiveVip 结果，避免本模块依赖数据库。
 */
function canCustomizeTime(user, isActiveVip) {
  if (!user) return false;
  const active = typeof isActiveVip === 'boolean' ? isActiveVip : isActiveVipFn(user);
  if (!active) return false;
  return tierAllowsCustomTime(user.vipTier);
}

// 兜底：与 server.js 中 hasActiveVip 等价（本模块不依赖 mongoose）
function isActiveVipFn(user) {
  if (!user || user.isVip !== true) return false;
  if (!user.vipExpireAt) return true;
  return new Date(user.vipExpireAt).getTime() > Date.now();
}

/* ---------------- 学号 / 年级 / 毕业时间 ---------------- */

/**
 * 从学号解析入学年份。
 * 兼容 2020xxxx 四位年份 与 22xxxxxx 两位年份两种格式。
 */
function enrollmentYear(studentId) {
  const sid = String(studentId || '').trim();
  if (!/^\d+$/.test(sid) || sid.length < 2) return null;

  let year = null;
  if (sid.length >= 8 && /^(19|20)\d{2}/.test(sid)) {
    year = parseInt(sid.slice(0, 4), 10);
  } else {
    year = 2000 + parseInt(sid.slice(0, 2), 10);
  }
  const currentYear = new Date().getFullYear();
  if (!Number.isFinite(year) || year < 2015 || year > currentYear + 1) return null;
  return year;
}

/** 以 8 月为学年分界，推算当前年级（1=大一 ...） */
function gradeLevel(studentId, now = new Date()) {
  const enroll = enrollmentYear(studentId);
  if (!enroll) return null;
  const month = now.getMonth() + 1;
  const academicYear = month >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const grade = academicYear - enroll + 1;
  if (grade < 1 || grade > 6) return null;
  return grade;
}

/** 毕业时间：入学年 + 4 年，7 月 15 日 23:59:59（北京时间） */
function graduationDate(studentId) {
  const enroll = enrollmentYear(studentId);
  if (!enroll) return null;
  return new Date(`${enroll + 4}-07-15T23:59:59+08:00`);
}

/**
 * 计算某套餐的到期时间（不落库，调用方负责保存）。
 * - 固定天数套餐：base + days（base 默认 now；会员未到期时传现有到期时间即"叠加"）
 * - 年级套餐：min(毕业日期, base + years*365)，毕业日期取不到时退回 base + years*365
 */
function computeExpireAt(plan, user, now = new Date(), base = null) {
  if (!plan) return null;
  const origin = (base && base.getTime() > now.getTime()) ? new Date(base.getTime()) : new Date(now.getTime());

  if (plan.kind === 'grade') {
    const cap = new Date(origin.getTime() + plan.years * 365 * DAY_MS);
    const grad = graduationDate(user && user.studentId);
    if (grad && grad.getTime() > origin.getTime()) {
      return new Date(Math.min(grad.getTime(), cap.getTime()));
    }
    return cap;
  }

  const days = Number(plan.days) || 0;
  return new Date(origin.getTime() + days * DAY_MS);
}

/** 是否为注册赠送的 3 天体验会员（有效期跨度 2~4 天且未到期） */
function isTrialMembership(user, now = new Date()) {
  if (!user || !user.isVip) return false;
  const exp = user.vipExpireAt ? new Date(user.vipExpireAt) : null;
  const start = user.vipStartAt ? new Date(user.vipStartAt) : null;
  if (!exp || !start) return false;
  if (exp.getTime() <= now.getTime()) return false;
  const span = exp.getTime() - start.getTime();
  return span >= 2 * DAY_MS && span <= 4 * DAY_MS;
}

/** 会员视图：给前端/后台统一展示 */
function membershipView(user, now = new Date()) {
  if (!user) return null;
  const active = isActiveVipFn(user);
  const normalized = normalizeTier(user.vipTier);
  const plan = PLAN_BY_TIER[normalized] || null;
  const exp = user.vipExpireAt ? new Date(user.vipExpireAt) : null;
  const start = user.vipStartAt ? new Date(user.vipStartAt) : null;
  const isExpired = !!(user.isVip && exp && exp.getTime() <= now.getTime());
  const expiredDays = isExpired ? Math.max(0, Math.floor((now.getTime() - exp.getTime()) / DAY_MS)) : 0;
  // 3 天体验会员识别（注册赠送）：有效期起点到终点的跨度约 2~4 天
  const trial = !isExpired && isTrialMembership(user, now);
  const planName = trial ? '3天体验会员' : (plan ? plan.name : (TIER_LABELS[normalized] || '会员'));
  return {
    isVip: !!user.isVip,
    active,
    expired: isExpired,
    expiredDays,
    trial,
    status: active ? 'active' : (isExpired ? 'expired' : 'free'),
    tier: normalized,
    planCode: plan ? plan.code : '',
    planName,
    canCustomTime: active && tierAllowsCustomTime(normalized),
    expireAt: user.vipExpireAt || null,
    startAt: user.vipStartAt || null
  };
}

module.exports = {
  DAY_MS,
  TIERS,
  TIER_VALUES,
  PLANS,
  PLAN_BY_CODE,
  PLAN_BY_TIER,
  TIER_RANK,
  CUSTOM_TIME_TIERS,
  TIER_LABELS,
  LEGACY_TIER_LABELS,
  normalizeTier,
  planForTier,
  planForCode,
  planMetaList,
  tierLabel,
  tierRank,
  tierAllowsCustomTime,
  canCustomizeTime,
  enrollmentYear,
  gradeLevel,
  graduationDate,
  computeExpireAt,
  isTrialMembership,
  membershipView
};
