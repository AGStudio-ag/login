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
