/* AG AI 公众演示交互（全部模拟数据；优先走独立演示网关，不可达时回退本地规则引擎） */
(function () {
  'use strict';

  var API_BASE = 'https://beta.agai.online';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ================= 本地规则引擎（与演示网关同规则） ================= */
  function localAnalyze(message) {
    var m = String(message || '');
    var intent = 'general', intentLabel = '通用咨询';
    if (/^(你好|您好|hi|hello|在吗|在不在|哈喽)/i.test(m.trim())) { intent = 'greeting'; intentLabel = '打招呼'; }
    else if (/(价格|多少钱|费用|收费|报价|套餐|优惠|打折)/.test(m)) { intent = 'price'; intentLabel = '询价'; }
    else if (/(退款|退货|售后|退钱|质量问题|坏|破损)/.test(m)) { intent = 'after_sale'; intentLabel = '售后'; }
    else if (/(预约|时间|安排|提醒|几点|明天|后天|今天|星期)/.test(m)) { intent = 'schedule'; intentLabel = '日程'; }
    else if (/(谢谢|感谢|辛苦了)/.test(m)) { intent = 'thanks'; intentLabel = '致谢'; }
    else if (/(怎么用|使用|教程|帮助|不会|如何)/.test(m)) { intent = 'help'; intentLabel = '使用帮助'; }

    var entities = [];
    var nums = m.match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length) entities.push('数字：' + nums.join('、'));
    var cnTime = m.match(/[一二两三四五六七八九十]+点(?:[零一二三四五六七八九十]+分)?/);
    if (cnTime) entities.push('时间：' + cnTime[0]);
    ['明天', '后天', '今天', '上午', '下午', '晚上', '周末'].forEach(function (w) {
      if (m.indexOf(w) >= 0) entities.push('时间：' + w);
    });

    var sentiment = 'neutral';
    if (/(很差|差评|糟糕|垃圾|太慢|气|投诉|生气|不满)/.test(m)) sentiment = 'negative';
    else if (/(很好|不错|喜欢|谢谢|赞|棒|满意)/.test(m)) sentiment = 'positive';

    var replies = {
      greeting: '你好呀，我是 AG AI 演示助手。想了解什么，直接告诉我就可以～',
      price: '好的，我先帮你整理一下报价信息。方便的话告诉我你的使用人数和场景，我给你一个更准确的参考。',
      after_sale: '收到你的售后问题，别着急。麻烦补充一下订单信息，我马上帮你转给人工跟进处理。',
      schedule: '已记录这条日程提醒。确认一下时间：' + (cnTime ? cnTime[0] : (nums && nums.length ? nums.join('、') : '待你确认')) + '，到点我会提醒你。',
      thanks: '不客气，能帮上忙就太好了。还有其他需要随时找我。',
      help: '可以这样用：直接把你想做的事发给我，我会先理解你的意图，再给出回复建议。也可以试试左侧的示例消息。',
      general: '我理解了你的意思：这属于「' + intentLabel + '」类消息。这是演示环境，正式版会接入你授权的平台自动处理这类消息。'
    };
    return {
      analysis: { intent: intent, intentLabel: intentLabel, entities: entities, sentiment: sentiment, summary: '识别为「' + intentLabel + '」意图。' },
      reply: replies[intent] || replies.general,
      mode: 'local-rules'
    };
  }

  function apiDemoReply(message, platform) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 7000) : null;
    return fetch(API_BASE + '/api/demo/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, platform: platform }),
      signal: controller ? controller.signal : undefined
    }).then(function (r) {
      var remaining = r.headers.get('X-Demo-Budget-Remaining');
      return r.json().then(function (j) {
        return { ok: r.ok, data: j, budget: remaining };
      });
    }).catch(function () {
      return { ok: false, data: null, budget: null, offline: true };
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  /* ================= 场景 1：智能消息处理 ================= */
  (function () {
    var chatBody = $('chatBody');
    var input = $('chatInput');
    var sendBtn = $('chatSend');
    var windowBox = $('chatWindow');
    var title = $('chatTitle');
    var currentSkin = 'wechat';

    var skins = {
      wechat: 'AG AI · 模拟微信会话',
      douyin: 'AG AI · 模拟抖音会话',
      generic: 'AG AI · 模拟通用会话'
    };

    document.querySelectorAll('.platform-tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.platform-tabs button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        currentSkin = b.getAttribute('data-skin');
        windowBox.className = 'chat-window skin-' + currentSkin;
        title.textContent = skins[currentSkin];
      });
    });

    document.querySelectorAll('.sample-chips button[data-msg]').forEach(function (b) {
      b.addEventListener('click', function () { send(b.getAttribute('data-msg')); });
    });

    function addMsg(cls, text) {
      var empty = chatBody.querySelector('.chat-empty');
      if (empty) empty.remove();
      var m = el('div', 'msg ' + cls, text);
      chatBody.appendChild(m);
      chatBody.scrollTop = chatBody.scrollHeight;
      return m;
    }

    function renderAnalysis(r, fromApi, budget) {
      var a = r.analysis;
      $('aIntent').innerHTML = '<span class="intent-badge">' + a.intentLabel + '</span><span style="margin-left:8px;color:var(--text-3);font-size:10.5px;">' + a.summary + '</span>';
      $('aEntities').innerHTML = (a.entities && a.entities.length)
        ? a.entities.map(function (e) { return '<span class="ent-chip">' + e + '</span>'; }).join('')
        : '未提取到关键信息';
      var sent = { positive: '偏正面', negative: '偏负面', neutral: '中性' }[a.sentiment] || '中性';
      $('aSentiment').innerHTML = '<b>' + sent + '</b>';
      $('aReply').innerHTML = '<div class="reply-card"><div class="reply-text">' + r.reply + '</div><button class="copy-btn" type="button" id="copyReply">复制建议回复</button></div>';
      var copyBtn = $('copyReply');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          try {
            navigator.clipboard.writeText(r.reply).then(function () { copyBtn.textContent = '已复制'; setTimeout(function () { copyBtn.textContent = '复制建议回复'; }, 1500); });
          } catch (e) { copyBtn.textContent = '复制失败，请手动选择'; }
        });
      }
      var badge = $('modeBadge');
      var tag = $('modeTag');
      if (fromApi) {
        badge.className = 'mode-badge api';
        badge.textContent = '演示网关 · server-rules';
        tag.textContent = '演示网关响应';
        $('budgetLine').textContent = budget !== null && budget !== undefined ? ('演示网关：今日剩余额度 ' + budget + ' 次调用') : '演示网关：独立接口，带限流与每日调用预算';
      } else {
        badge.className = 'mode-badge local';
        badge.textContent = '本地规则引擎';
        tag.textContent = '网关暂不可达，已回退本地规则';
        $('budgetLine').textContent = '演示网关未连接，当前由页面内置的本地规则引擎响应';
      }
    }

    function send(text) {
      var msg = (text || '').trim();
      if (!msg) return;
      addMsg('user', msg);
      input.value = '';
      var typing = addMsg('typing', 'AG AI 正在理解这条消息…');
      var platform = currentSkin === 'douyin' ? 'douyin' : currentSkin === 'wechat' ? 'wechat' : 'other';
      apiDemoReply(msg, platform).then(function (res) {
        typing.remove();
        var result;
        var fromApi = false;
        if (res.ok && res.data && res.data.analysis) {
          result = res.data;
          fromApi = true;
        } else {
          result = localAnalyze(msg);
        }
        addMsg('assistant', result.reply);
        renderAnalysis(result, fromApi, res.budget);
      });
    }

    sendBtn.addEventListener('click', function () { send(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(input.value); });
  })();

  /* ================= 场景 2：自动化工作流 ================= */
  (function () {
    var scenarios = {
      order: {
        name: '新订单消息',
        steps: [
          { name: '触发', cls: 'info', log: '收到授权渠道的新消息：「我要 3 份资料包，怎么付款？」' },
          { name: '分析', cls: 'info', log: '意图=下单 · 数量=3 · 商品=资料包 · 情绪=中性' },
          { name: '判断', cls: 'info', log: '命中「新订单」流程：需要确认价格与支付方式，无需转人工' },
          { name: '执行', cls: 'ok', log: '生成报价回复并发送；创建待跟进提醒（2 小时后确认付款）' },
          { name: '反馈', cls: 'ok', log: '结果已写入记录：回复已发送，跟进任务已排期，流程耗时 1.2s' }
        ],
        result: '流程执行完成：报价回复已发送，付款跟进已排期。全程无需人工介入。'
      },
      alert: {
        name: '异常消息上报',
        steps: [
          { name: '触发', cls: 'info', log: '收到消息：「你们的系统打不开了，一直转圈」' },
          { name: '分析', cls: 'info', log: '意图=故障投诉 · 关键词=系统/打不开 · 情绪=负面' },
          { name: '判断', cls: 'warn', log: '命中「异常上报」规则：安抚客户 + 通知值班人员，优先级=高' },
          { name: '执行', cls: 'ok', log: '发送安抚回复；创建故障工单并推送提醒给值班人员' },
          { name: '反馈', cls: 'ok', log: '工单 #DEMO-1024 已创建，通知已送达，结果已记录' }
        ],
        result: '异常已自动上报：客户收到安抚回复，值班人员收到工单提醒。'
      },
      daily: {
        name: '每日内容整理',
        steps: [
          { name: '触发', cls: 'info', log: '定时任务 08:00 触发：整理昨日未读消息与待办' },
          { name: '分析', cls: 'info', log: '扫描 3 个授权渠道：12 条新消息，其中 4 条需要回复' },
          { name: '判断', cls: 'info', log: '按优先级排序：1 条售后优先，2 条普通咨询，1 条寒暄' },
          { name: '执行', cls: 'ok', log: '生成 4 条回复草稿；汇总成晨报，标注需要人工确认的事项' },
          { name: '反馈', cls: 'ok', log: '晨报已生成并推送，等待你对回复草稿的确认' }
        ],
        result: '晨报已生成：4 条回复草稿待确认，1 条售后消息标记为优先。'
      }
    };

    var nodes = document.querySelectorAll('.flow-node');
    var logBox = $('flowLog');
    var runBtn = $('flowRun');
    var resetBtn = $('flowReset');
    var resultBox = $('flowResult');
    var progress = $('flowProgress');
    var current = 'order';
    var running = false;
    var timers = [];

    document.querySelectorAll('.flow-scenarios button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (running) return;
        document.querySelectorAll('.flow-scenarios button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        current = b.getAttribute('data-flow');
        reset();
      });
    });

    function clearTimers() { timers.forEach(clearTimeout); timers = []; }
    function logLine(text, cls) {
      var line = el('div');
      line.innerHTML = '<span class="t">[' + new Date().toTimeString().slice(0, 8) + ']</span><span class="' + (cls || '') + '">' + text + '</span>';
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function reset() {
      clearTimers();
      running = false;
      runBtn.disabled = false;
      nodes.forEach(function (n) { n.classList.remove('active', 'done'); });
      logBox.innerHTML = '';
      resultBox.hidden = true;
      progress.style.width = '0';
      logLine('选择场景后点击「运行演示」开始。', 'info');
    }

    function run() {
      if (running) return;
      running = true;
      runBtn.disabled = true;
      resultBox.hidden = true;
      progress.style.width = '0';
      var sc = scenarios[current];
      logLine('开始运行「' + sc.name + '」流程…', 'info');
      var delay = 0;
      sc.steps.forEach(function (step, i) {
        delay += 750;
        timers.push(setTimeout(function () {
          nodes.forEach(function (n, j) {
            n.classList.toggle('active', j === i);
            n.classList.toggle('done', j < i);
          });
          progress.style.width = ((i + 1) / 5 * 100) + '%';
          logLine(step.log, step.cls);
          if (i === sc.steps.length - 1) {
            timers.push(setTimeout(function () {
              nodes.forEach(function (n) { n.classList.remove('active'); n.classList.add('done'); });
              resultBox.hidden = false;
              resultBox.innerHTML = '<b>运行完成</b> · ' + sc.result;
              running = false;
              runBtn.disabled = false;
            }, 550));
          }
        }, delay));
      });
    }

    runBtn.addEventListener('click', run);
    resetBtn.addEventListener('click', reset);
    reset();
  })();

  /* ================= 场景 3：智能记忆与理解 ================= */
  (function () {
    var chatBody = $('memChatBody');
    var input = $('memChatInput');
    var sendBtn = $('memChatSend');
    var memList = $('memList');
    var memSwitch = $('memSwitch');
    var memSwitchLabel = $('memSwitchLabel');
    var memReset = $('memReset');
    var memories = [];
    var memoryOn = true;

    function renderMemories() {
      memList.innerHTML = '';
      if (!memories.length) {
        memList.appendChild(el('div', 'mem-empty', '还没有记忆。输入「记住：…」教它一条。'));
        return;
      }
      memories.forEach(function (m, idx) {
        var li = el('li');
        li.appendChild(document.createTextNode(m));
        var del = el('button', null, '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          memories.splice(idx, 1);
          renderMemories();
          addMsg('assistant', '好的，这条偏好我已经忘了。');
        });
        li.appendChild(del);
        memList.appendChild(li);
      });
    }

    function addMsg(cls, text) {
      var empty = chatBody.querySelector('.chat-empty');
      if (empty) empty.remove();
      var m = el('div', 'msg ' + cls, text);
      chatBody.appendChild(m);
      chatBody.scrollTop = chatBody.scrollHeight;
      return m;
    }

    function buildReply(question) {
      if (!memoryOn || !memories.length) {
        return '（未使用记忆）' + question + ' —— 建议你关注手头的三件事，按重要程度排序处理。';
      }
      var nameMem = memories.find(function (m) { return m.indexOf('叫') >= 0 || m.indexOf('称呼') >= 0; });
      var styleMem = memories.find(function (m) { return m.indexOf('简洁') >= 0 || m.indexOf('结论') >= 0 || m.indexOf('风格') >= 0; });
      var prefix = nameMem ? nameMem.replace(/^记住[：:]\s*/, '') + '，' : '';
      var tone = styleMem ? '我先给结论：' : '详细说明如下：';
      return prefix + tone + '明天的安排共有 3 项，最重要的一项是上午 10 点的演示评审，建议提前 15 分钟准备。';
    }

    function send(text) {
      var msg = (text || '').trim();
      if (!msg) return;
      addMsg('user', msg);
      input.value = '';
      if (/^记住[：:]/.test(msg)) {
        var mem = msg.replace(/^记住[：:]\s*/, '');
        memories.push(mem);
        renderMemories();
        addMsg('assistant', '已记住：「' + mem + '」。之后我的回复会参考这条偏好。');
        return;
      }
      var typing = addMsg('typing', 'AG AI 正在组织回复…');
      setTimeout(function () {
        typing.remove();
        addMsg('assistant', buildReply(msg));
      }, 650);
    }

    memSwitch.addEventListener('click', function () {
      memoryOn = !memoryOn;
      memSwitch.classList.toggle('on', memoryOn);
      memSwitch.setAttribute('aria-checked', String(memoryOn));
      memSwitchLabel.textContent = memoryOn ? '记忆已开启 · 回复会参考你的偏好' : '记忆已关闭 · 回复不使用历史偏好';
      addMsg('assistant', memoryOn ? '记忆已重新开启。' : '记忆已关闭，接下来我会按通用方式回复。');
    });

    memReset.addEventListener('click', function () {
      memories = [];
      renderMemories();
      chatBody.innerHTML = '';
      chatBody.appendChild(el('div', 'chat-empty', '已清空。可以重新教它一条偏好，再提问对比效果。'));
    });

    document.querySelectorAll('.sample-chips button[data-mem]').forEach(function (b) {
      b.addEventListener('click', function () { send(b.getAttribute('data-mem')); });
    });

    sendBtn.addEventListener('click', function () { send(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(input.value); });
    renderMemories();
  })();

  /* ================= 演示导航高亮 ================= */
  (function () {
    var links = document.querySelectorAll('.demo-nav a');
    var sections = [];
    links.forEach(function (a) {
      var target = document.querySelector(a.getAttribute('href'));
      if (target) sections.push({ a: a, el: target });
    });
    function onScroll() {
      var pos = window.scrollY + 120;
      var current = null;
      sections.forEach(function (s) {
        if (s.el.offsetTop <= pos) current = s.a;
      });
      links.forEach(function (a) { a.classList.toggle('on', a === current); });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  })();
})();
