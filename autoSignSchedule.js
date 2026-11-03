'use strict';
/**
 * 自动签到：某条订阅今天这次运行是否应该执行（纯逻辑，方便单测）
 *
 * 背景：21:35 的主批次和“自定义时间”的每分钟批次共用 executeAutoSign。
 * 主批次传 targetTime='21:35'，但只有 Pro/年级卡有自定义时间权限；
 * 旧的判断 `targetTime && !canCustomSignTime()` 会把月卡/学期卡/学年卡/LEGACY 全部排除，
 * 导致 21:35 只剩少数人签到。这里明确区分“默认时间批次”和“自定义时间批次”。
 */

function isSubscriptionDueToday({
  subTime,
  planTime,
  scheduleType,
  customDays,
  dayOfWeek,
  isCustomTimeRun,
  canCustomTime
}) {
  if (!subTime || !planTime || subTime !== planTime) return false;
  // 仅“自定义时间批次”需要自定义时间权限；默认 21:35 批次对所有有效会员开放
  if (isCustomTimeRun && !canCustomTime) return false;
  if (scheduleType === 'daily') return true;
  if (scheduleType === 'weekdays') return dayOfWeek >= 1 && dayOfWeek <= 5;
  if (scheduleType === 'custom') {
    return Array.isArray(customDays) && customDays.map(Number).includes(Number(dayOfWeek));
  }
  return false;
}

module.exports = { isSubscriptionDueToday };
