/* AG AI 内测申请表单（提交到独立内测 API） */
(function () {
  'use strict';

  var API_BASE = 'https://beta.agai.online';

  var form = document.getElementById('betaForm');
  var submitBtn = document.getElementById('betaSubmit');
  var resultBox = document.getElementById('betaResult');
  var contactInput = document.getElementById('fContact');
  var errContact = document.getElementById('errContact');
  if (!form) return;

  function showResult(kind, html) {
    resultBox.hidden = false;
    resultBox.className = 'form-result ' + kind;
    resultBox.innerHTML = html;
  }
  function showError(msg) {
    showResult('err', '<b>提交失败：</b>' + msg);
  }

  contactInput.addEventListener('input', function () {
    if (contactInput.value.trim().length >= 3) errContact.hidden = true;
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var contact = contactInput.value.trim();
    var valid = true;
    if (contact.length < 3 || contact.length > 100) {
      errContact.hidden = false;
      valid = false;
    } else {
      errContact.hidden = true;
    }
    if (!valid) return;

    var industry = document.getElementById('fIndustry').value;
    var scenario = document.getElementById('fScenario').value;
    var note = document.getElementById('fNote').value.trim();
    var platforms = Array.prototype.slice.call(form.querySelectorAll('input[name="platforms"]:checked'))
      .map(function (c) { return c.value; });

    var payload = {
      contact: contact,
      industry: industry || '其他',
      scenario: scenario,
      platforms: platforms,
      note: note
    };

    submitBtn.disabled = true;
    submitBtn.textContent = '正在提交…';
    resultBox.hidden = true;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 10000) : null;

    fetch(API_BASE + '/api/beta/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, data: j }; });
    }).then(function (res) {
      if (res.status === 200 && res.data && res.data.ok) {
        showResult('ok', '<b>申请已提交 ✓</b> 申请编号 <span class="mono">' + res.data.id + '</span>。已进入后台待审核列表，我们会通过你留下的联系方式与你联系。');
        form.querySelectorAll('input,select,textarea').forEach(function (n) {
          if (n.type !== 'checkbox') n.disabled = false;
        });
        submitBtn.textContent = '已提交';
      } else if (res.status === 429) {
        showError('提交过于频繁，请稍后再试。');
      } else {
        showError(res.data && res.data.message ? res.data.message : '服务暂时不可用，请稍后重试。');
      }
      submitBtn.disabled = false;
      if (submitBtn.textContent !== '已提交') submitBtn.textContent = '提交申请';
    }).catch(function () {
      showError('无法连接到申请服务，请检查网络后重试，或邮件联系 support@agai.online。');
      submitBtn.disabled = false;
      submitBtn.textContent = '提交申请';
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  });
})();
