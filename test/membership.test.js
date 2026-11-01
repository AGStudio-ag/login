'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../membership');

const NOW = new Date('2026-11-01T10:00:00+08:00');

test('七种套餐价格与名称与需求表一致', () => {
  const expected = [
    ['monthly', '月卡', 6.66],
    ['term', '学期卡', 9.99],
    ['yearly', '学年卡', 15.01],
    ['yearly_pro', '学年卡 Pro', 20.0],
    ['freshman', '大一学年卡（启航卡）', 49.9],
    ['sophomore', '大二学年卡（续航卡）', 39.9],
    ['junior', '大三学年卡（冲刺卡）', 28.8]
  ];
  assert.equal(M.PLANS.length, 7);
  expected.forEach(([code, name, price], index) => {
    const plan = M.planForCode(code);
    assert.ok(plan, code + ' 应存在');
    assert.equal(plan.name, name);
    assert.equal(plan.price, price);
    assert.equal(plan.sort, index + 1);
  });
});

test('折合每年数值正确', () => {
  assert.equal(M.planForCode('yearly').pricePerYear, 15.01);
  assert.equal(M.planForCode('yearly_pro').pricePerYear, 20.0);
  assert.equal(M.planForCode('freshman').pricePerYear, 12.48);
  assert.equal(M.planForCode('sophomore').pricePerYear, 13.3);
  assert.equal(M.planForCode('junior').pricePerYear, 14.4);
});

test('自定义时间权限：仅 Pro 与三种年级卡', () => {
  for (const code of ['monthly', 'term', 'yearly']) {
    assert.equal(M.planForCode(code).customTime, false, code + ' 不应支持自定义时间');
  }
  for (const code of ['yearly_pro', 'freshman', 'sophomore', 'junior']) {
    assert.equal(M.planForCode(code).customTime, true, code + ' 应支持自定义时间');
  }
});

test('旧 VIP 映射为学年卡 Pro，SVIP 保持历史含义', () => {
  assert.equal(M.normalizeTier('VIP'), 'YEARLY_PRO');
  assert.equal(M.normalizeTier('vip'), 'YEARLY_PRO');
  assert.equal(M.tierLabel('VIP'), '学年卡 Pro');
  assert.equal(M.tierLabel('YEARLY_PRO'), '学年卡 Pro');
  assert.equal(M.tierLabel('SVIP'), '长期会员（至毕业）');
  assert.ok(M.tierAllowsCustomTime('SVIP'));
});

test('固定天数套餐到期时间', () => {
  const user = { studentId: '23xxxx', isVip: true, vipExpireAt: new Date(NOW.getTime() + 999 * M.DAY_MS) };
  assert.equal(M.computeExpireAt(M.planForCode('monthly'), user, NOW).toISOString(), new Date('2026-12-01T02:00:00.000Z').toISOString());
  assert.equal(M.computeExpireAt(M.planForCode('term'), user, NOW).toISOString(), new Date('2027-03-01T02:00:00.000Z').toISOString());
  assert.equal(M.computeExpireAt(M.planForCode('yearly'), user, NOW).toISOString(), new Date('2027-11-01T02:00:00.000Z').toISOString());
});

test('年级套餐按毕业日期计算（2026 级大一 -> 2030-07-15）', () => {
  const user = { studentId: '26123456' };
  const expire = M.computeExpireAt(M.planForCode('freshman'), user, NOW);
  assert.equal(expire.toISOString(), new Date('2030-07-15T15:59:59.000Z').toISOString());
});

test('年级套餐不会超过套餐年限（大一买大三卡最多 2 年）', () => {
  const user = { studentId: '26123456' };
  const expire = M.computeExpireAt(M.planForCode('junior'), user, NOW);
  const cap = new Date(NOW.getTime() + 2 * 365 * M.DAY_MS);
  assert.equal(expire.toISOString(), cap.toISOString());
});

test('高年级购买低年级卡按毕业日期封顶', () => {
  const user = { studentId: '23123456' }; // 2023 级，2027-07-15 毕业
  const expire = M.computeExpireAt(M.planForCode('freshman'), user, NOW);
  assert.equal(expire.toISOString(), new Date('2027-07-15T15:59:59.000Z').toISOString());
});

test('学号无法解析时年级套餐退回年限天数', () => {
  const user = { studentId: 'guest_abc' };
  const expire = M.computeExpireAt(M.planForCode('sophomore'), user, NOW);
  assert.equal(expire.toISOString(), new Date(NOW.getTime() + 3 * 365 * M.DAY_MS).toISOString());
});

test('年级与入学年份推算', () => {
  assert.equal(M.enrollmentYear('26123456'), 2026);
  assert.equal(M.enrollmentYear('2026123456'), 2026);
  assert.equal(M.enrollmentYear('guest_x'), null);
  assert.equal(M.gradeLevel('26123456', NOW), 1);
  assert.equal(M.gradeLevel('25123456', NOW), 2);
  assert.equal(M.gradeLevel('24123456', NOW), 3);
  assert.equal(M.gradeLevel('23123456', NOW), 4);
});

test('权益判断：会员有效 + 等级支持才允许自定义时间', () => {
  const active = { isVip: true, vipTier: 'YEARLY_PRO', vipExpireAt: new Date(NOW.getTime() + M.DAY_MS) };
  assert.equal(M.canCustomizeTime(active), true);
  assert.equal(M.canCustomizeTime({ ...active, isVip: false }), false);
  assert.equal(M.canCustomizeTime({ ...active, vipExpireAt: new Date(NOW.getTime() - M.DAY_MS) }), false);
  assert.equal(M.canCustomizeTime({ ...active, vipTier: 'YEARLY' }), false);
  assert.equal(M.canCustomizeTime({ ...active, vipTier: 'VIP' }), true);
});

test('会员视图输出前端需要的字段', () => {
  const view = M.membershipView({ isVip: true, vipTier: 'VIP', vipExpireAt: new Date(NOW.getTime() + M.DAY_MS) }, NOW);
  assert.equal(view.tier, 'YEARLY_PRO');
  assert.equal(view.planName, '学年卡 Pro');
  assert.equal(view.canCustomTime, true);
  assert.equal(view.active, true);
});

// ===== 3 天体验会员付费升级规则（2026-11-02）=====

test('体验会员付费：到期时间在剩余体验期基础上叠加，不吞天数', () => {
  const day = M.DAY_MS;
  // 第 1 天注册体验：起点 NOW，到期 NOW+3天
  const trialUser = {
    studentId: '269064010',
    isVip: true,
    vipTier: 'YEARLY_PRO',
    vipStartAt: new Date(NOW.getTime()),
    vipExpireAt: new Date(NOW.getTime() + 3 * day)
  };
  const buyAt = new Date(NOW.getTime() + 1 * day); // 第 2 天付款买月卡(30天)
  const expire = M.computeExpireAt(M.planForCode('monthly'), trialUser, buyAt, new Date(trialUser.vipExpireAt));
  // NOW+3天（体验到期）+ 30天
  assert.equal(expire.toISOString(), new Date(NOW.getTime() + 33 * day).toISOString());
});

test('体验会员识别：跨度 3 天为体验，付费后跨度变大即不再是体验', () => {
  const day = M.DAY_MS;
  const trialUser = { isVip: true, vipStartAt: new Date(NOW.getTime()), vipExpireAt: new Date(NOW.getTime() + 3 * day) };
  assert.equal(M.isTrialMembership(trialUser, NOW), true);
  const paidUser = { isVip: true, vipTier: 'MONTHLY', vipStartAt: new Date(NOW.getTime() + day), vipExpireAt: new Date(NOW.getTime() + 33 * day) };
  assert.equal(M.isTrialMembership(paidUser, NOW), false);
  assert.equal(M.membershipView(paidUser, NOW).planName, '月卡'); // 付费后标签按购买的套餐
});

test('年级卡叠加后仍以毕业日期封顶', () => {
  const day = M.DAY_MS;
  const user = { studentId: '26123456', isVip: true, vipTier: 'YEARLY_PRO', vipStartAt: NOW, vipExpireAt: new Date(NOW.getTime() + 3 * day) };
  const expire = M.computeExpireAt(M.planForCode('freshman'), user, NOW, new Date(user.vipExpireAt));
  assert.equal(expire.toISOString(), new Date('2030-07-15T15:59:59.000Z').toISOString());
});

// ===== 等级契约一致性（/api/admin/tier-meta 的数据源护栏）=====

test('等级契约：每个在售套餐都有中文标签（PLANS ⊆ TIER_LABELS）', () => {
  const labels = M.TIER_LABELS;
  for (const plan of M.PLANS) {
    assert.ok(labels[plan.tier], `套餐 ${plan.code} 的等级 ${plan.tier} 缺少 TIER_LABELS 条目`);
  }
});

test('等级契约：TIER_LABELS 恒为 11 项，历史等级恰好是 VIP/SVIP/LEGACY', () => {
  const labels = M.TIER_LABELS;
  assert.equal(Object.keys(labels).length, 11);
  const planTiers = new Set(M.PLANS.map(p => p.tier));
  const legacy = Object.keys(labels).filter(t => t !== 'FREE' && !planTiers.has(t));
  assert.deepEqual(legacy.sort(), ['LEGACY', 'SVIP', 'VIP']);
});

test('等级契约：自定义时间清单只允许出现在 TIER_LABELS 内的等级', () => {
  for (const tier of M.CUSTOM_TIME_TIERS) {
    assert.ok(M.TIER_LABELS[tier], `CUSTOM_TIME_TIERS 里的 ${tier} 不在 TIER_LABELS 中`);
    // 允许历史别名（VIP → YEARLY_PRO），规范化后必须仍是一个带中文标签的合法等级
    const norm = M.normalizeTier(tier);
    assert.ok(M.TIER_LABELS[norm], `CUSTOM_TIME_TIERS 里的 ${tier} 规范化后 ${norm} 没有中文标签`);
  }
});

test('等级契约：旧 VIP 归一化为 YEARLY_PRO（所以 UI 显示同名是预期）', () => {
  assert.equal(M.normalizeTier('VIP'), 'YEARLY_PRO');
  assert.equal(M.TIER_LABELS.VIP, M.TIER_LABELS.YEARLY_PRO);
});
