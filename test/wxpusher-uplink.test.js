'use strict';

/**
 * WxPusher 回调解析单测（上行消息 / 关注事件）
 * 真实格式参考：{"action":"send_up_cmd","data":{"uid":"UID_x","content":"#145060 内容"}}
 */

const test = require('node:test');
const assert = require('node:assert');
const W = require('../wxpusherService');

test('stripAppIdPrefix：去掉 #145060 前缀（空格/全角#/冒号都兼容）', () => {
  assert.equal(W.stripAppIdPrefix('#145060 签到失败'), '签到失败');
  assert.equal(W.stripAppIdPrefix('# 145060 签到失败'), '签到失败');
  assert.equal(W.stripAppIdPrefix('＃145060 签到失败'), '签到失败');
  assert.equal(W.stripAppIdPrefix('#145060：签到失败'), '签到失败');
  assert.equal(W.stripAppIdPrefix('#145060: 签到失败'), '签到失败');
  assert.equal(W.stripAppIdPrefix('  #145060   多行\n内容  '), '多行\n内容');
});

test('stripAppIdPrefix：没有前缀 / 别的 AppId 保持原样', () => {
  assert.equal(W.stripAppIdPrefix('直接发的反馈'), '直接发的反馈');
  assert.equal(W.stripAppIdPrefix('#999999 不是我们的'), '#999999 不是我们的');
  assert.equal(W.stripAppIdPrefix('#145060'), '');
  assert.equal(W.stripAppIdPrefix(''), '');
  assert.equal(W.stripAppIdPrefix(null), '');
});

test('parseCallback：send_up_cmd 识别为上行消息并清洗内容', () => {
  const evt = W.parseCallback({
    action: 'send_up_cmd',
    data: { uid: 'UID_TEST1', appId: 145060, content: '#145060 晚上签到一直失败' }
  }, '145060');
  assert.equal(evt.isUplink, true);
  assert.equal(evt.isSubscribe, false);
  assert.equal(evt.uid, 'UID_TEST1');
  assert.equal(evt.content, '晚上签到一直失败');
});

test('parseCallback：app_subscribe 是关注事件，不算上行消息', () => {
  const evt = W.parseCallback({
    action: 'app_subscribe',
    data: { uid: 'UID_TEST2', extra: '229144005' }
  });
  assert.equal(evt.isUplink, false);
  assert.equal(evt.isSubscribe, true);
  assert.equal(evt.uid, 'UID_TEST2');
  assert.equal(evt.extra, '229144005');
  assert.equal(evt.content, '');
});

test('parseCallback：关注事件即使带 content 也不当反馈（防串事件）', () => {
  const evt = W.parseCallback({ action: 'app_subscribe', data: { uid: 'U', extra: '123', content: '#145060 hi' } });
  assert.equal(evt.isSubscribe, true);
  assert.equal(evt.isUplink, false);
});

test('parseCallback：action 缺失时按 content 兜底判断', () => {
  const uplink = W.parseCallback({ data: { uid: 'UID_X', content: '#145060 你好' } });
  assert.equal(uplink.isUplink, true);
  assert.equal(uplink.content, '你好');

  const empty = W.parseCallback({ data: { uid: 'UID_X' } });
  assert.equal(empty.isUplink, false);
});

test('parseCallback：空 body / 直接平铺字段都不崩', () => {
  const empty = W.parseCallback(null);
  assert.equal(empty.uid, '');
  assert.equal(empty.isUplink, false);

  const flat = W.parseCallback({ uid: 'UID_FLAT', content: '#145060 平铺格式', action: 'send_up_cmd' });
  assert.equal(flat.uid, 'UID_FLAT');
  assert.equal(flat.content, '平铺格式');
  assert.equal(flat.isUplink, true);
});
