'use strict';
/**
 * 自动签到运行控制（纯逻辑，方便单测）
 *
 * 1) 批次超时：旧代码整批写死 115s。接口一慢，一批 5 人里只要有 1 人重试，
 *    整批就会被 kill 并全部记成失败，已经成功的结果也丢掉。
 *    预算按人数放大：30s 固定开销 + 每人 20s，最低 90s（兼容 1~3 人批次的冷启动）。
 * 2) 运行级互斥：21:35 主批次、管理员「一键全员签到」、22:00/23:30 补签、
 *    每分钟自定义时间批次都可能同时触发。并发会重复提交、重复写 SignLog、
 *    多计 totalSignCount，还会互相 reset 失败推送去重状态。
 */

const MIN_BATCH_TIMEOUT_MS = 90 * 1000;
const BATCH_BASE_TIMEOUT_MS = 30 * 1000;
const BATCH_PER_USER_TIMEOUT_MS = 20 * 1000;

function batchTimeoutMs(userCount) {
  const n = Math.max(1, Number(userCount) || 0);
  return Math.max(
    MIN_BATCH_TIMEOUT_MS,
    BATCH_BASE_TIMEOUT_MS + BATCH_PER_USER_TIMEOUT_MS * n
  );
}

/**
 * 进程内互斥锁。tryStart 是同步的：检查 + 占位之间没有 await，
 * 所以同一个进程里的并发调用只会有一个成功。
 */
function createRunLock(now = Date.now) {
  let current = null;
  return {
    get current() {
      return current;
    },
    tryStart(targetTime) {
      if (current) {
        return {
          ok: false,
          runningFor: Math.max(0, Math.round((now() - current.startedAt) / 1000)),
          current
        };
      }
      current = { startedAt: now(), targetTime: targetTime || null };
      return { ok: true, current };
    },
    finish() {
      current = null;
    }
  };
}

module.exports = {
  batchTimeoutMs,
  createRunLock,
  MIN_BATCH_TIMEOUT_MS,
  BATCH_BASE_TIMEOUT_MS,
  BATCH_PER_USER_TIMEOUT_MS
};
