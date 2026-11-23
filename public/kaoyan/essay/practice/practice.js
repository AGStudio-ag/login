(function () {
  "use strict";
  const DATA = (window.ESSAY_LESSONS && window.ESSAY_LESSONS.years) || [];
  if (!DATA.length) {
    document.getElementById("qcard").innerHTML = '<div class="noimg">数据加载失败：请确认 data/lessons.js 已生成。</div>';
    return;
  }

  const TYPE = {
    A: ["A 动态", "a"],
    B1: ["B1 饼图", "b"],
    B2: ["B2 多选柱状", "b"],
    C: ["C 表格", "g"],
    D: ["D 双图", "g"],
    E: ["E 图画文字", "g"]
  };
  const STEPS = [
    { n: 0, name: "① 审题", range: [] },
    { n: 1, name: "② 判型", range: [] },
    { n: 2, name: "③ P1 描述", range: [1, 2, 3, 4] },
    { n: 3, name: "④ P2 原因", range: [5, 6, 7, 8] },
    { n: 4, name: "⑤ P3 评论", range: [9, 10, 11] },
    { n: 5, name: "⑥ 成文", range: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
  ];
  const TIPS = {
  1: "总起：图表类型 + 主题词，一句说清。",
  2: "一句话列全数据：静态数全部类别，动态写首、中、尾。",
  3: "主题总起：主题词与第 1、8 句必须是同一个。",
  4: "个人层面：填【具体行为】，from 语料库，用动词原形。",
  5: "政策层面：填【相关领域】，后半句 achieve their full potential 固定。",
  6: "社会层面：填【社会效果】，用动名词短语。",
  7: "宏观收束：整句固定，一个字不改。",
  8: "共识：再填一次【主题词】，保持三处一致。",
  9: "倡导：整句固定，一个字不改。"
};
  const GRADES = [
    ["full", "满分版"],
    ["simple", "简化版"],
    ["standard", "速通·标准"],
    ["brainless", "速通·无脑"]
  ];

  let idx = 0;          // 年份索引
  let step = 0;         // 0-5
  let revealed = new Set();
  let mode = "draft";
  let grade = "full";

  const $ = id => document.getElementById(id);
  const cur = () => DATA[idx];
  const key = "essay-practice-v1";

  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    if (typeof saved.idx === "number" && saved.idx >= 0 && saved.idx < DATA.length) idx = saved.idx;
    if (saved.theme) document.documentElement.setAttribute("data-theme", saved.theme);
  } catch (e) {}

  function save() {
    try { localStorage.setItem(key, JSON.stringify({ idx, theme: document.documentElement.getAttribute("data-theme") })); } catch (e) {}
  }

  function typeInfo(t) {
    const base = TYPE[t] || [t, "g"];
    if (t === "A") return ["A 动态", "a"];
    return base;
  }

  function renderYears() {
    $("yearbar").innerHTML = DATA.map((y, i) =>
      '<button class="ybtn' + (i === idx ? " on" : "") + '" data-i="' + i + '">' +
      y.year + "<small>" + (TYPE[y.type] ? TYPE[y.type][0].split(" ")[0] : y.type) + "</small></button>"
    ).join("");
    $("yearbar").querySelectorAll(".ybtn").forEach(b => {
      b.onclick = () => { idx = +b.dataset.i; step = 0; revealed.clear(); grade = "full"; renderAll(); save(); };
    });
  }

  function renderQ() {
    const y = cur();
    const ti = typeInfo(y.type);
    const redline = y.draft.redline || "";
    $("qcard").innerHTML =
      '<div class="qmain">' +
        '<div class="tags">' +
          '<span class="tag ' + ti[1] + '">' + ti[0] + "</span>" +
          '<span class="tag">' + y.year + " 英语 Part B</span>" +
          '<span class="tag g">定稿 ' + y.draft.words + " 词</span>" +
        "</div>" +
        "<h2>" + y.year + " 真题 · " + (ti[0]) + "</h2>" +
        "<p>" + (y.question || "") + "</p>" +
        '<div class="theme">' + (y.theme.en || "") + "　<span style=\"opacity:.65\">" + (y.theme.zh || "") + "</span></div>" +
        (redline ? '<div class="redline">红线：' + redline + "</div>" : "") +
      "</div>" +
      '<div class="qimg">' + (y.image ? '<img src="' + y.image + '" alt="' + y.year + ' 真题图表">' : '<div class="noimg">本题题图未取得</div>') + "</div>";
  }

  function renderSteps() {
    $("stepbar").innerHTML = STEPS.map(s =>
      '<button class="sbtn' + (s.n === step ? " on" : (s.n < step ? " done" : "")) + '" data-s="' + s.n + '">' + s.name + "</button>"
    ).join("");
    $("stepbar").querySelectorAll(".sbtn").forEach(b => {
      b.onclick = () => { step = +b.dataset.s; if (step === 5) revealAll(); renderStage(); };
    });
  }

  function revealAll() {
    cur().draft.sentences.forEach(s => revealed.add(s.n));
  }

  function renderStage() {
    const y = cur();
    const box = $("stage");
    if (step === 0) {
      box.innerHTML = '<div class="emptystep"><b>先自己审题（30 秒）</b><br>看题注、横轴/扇区、单位；问自己：有时间轴吗？百分比加起来是多少？<br><span style="color:var(--brand)">想好了点「下一步」看判型。</span></div>';
      updateWC();
      return;
    }
    if (step === 1) {
      const ti = typeInfo(y.type);
      box.innerHTML = '<div class="emptystep" style="text-align:left;line-height:2">' +
        '<b style="color:var(--brand);font-size:15px">判型：' + ti[0] + "</b><br>" +
        "口诀：看时间轴，不看图形。柱子 + 年份 = 动态；柱子 + 百分比 = 静态。<br>" +
        "P2 主题句：" + (y.type === "A" ? "this trend" : (y.type === "B1" || y.type === "B2" ? "this pattern" : "this situation / this phenomenon")) + "<br>" +
        "时态：" + (y.type === "A" ? "过去时" : "现在时") + "<br>" +
        '<span style="color:var(--red)">本题红线：' + (y.draft.redline || "见 02 一页纸") + "</span>" +
        "</div>";
      updateWC();
      return;
    }
    const range = STEPS[step].range;
    const list = y.draft.sentences.filter(s => range.includes(s.n));
    box.innerHTML = list.map(s => {
      const hidden = !revealed.has(s.n);
      return '<div class="sent' + (hidden ? " hide" : "") + '" data-n="' + s.n + '">' +
        '<div class="top"><span class="no">' + s.n + '</span><span class="p">P' + s.p + "</span><span>" + (TIPS[s.n] || "") + "</span></div>" +
        '<div class="en">' + s.en + "</div>" +
        '<div class="tip">' + (hidden ? "点击揭示" : "点击可再次遮住") + "</div></div>";
    }).join("");
    box.querySelectorAll(".sent").forEach(el => {
      el.onclick = () => {
        const n = +el.dataset.n;
        if (revealed.has(n)) revealed.delete(n); else revealed.add(n);
        renderStage();
      };
    });
    updateWC();
  }

  function updateWC() {
    const y = cur();
    const range = STEPS[step].range;
    const shown = step >= 2 ? y.draft.sentences.filter(s => range.includes(s.n)) : [];
    const wc = shown.reduce((a, s) => a + (s.en.match(/[A-Za-z0-9][A-Za-z0-9.%'\-]*/g) || []).length, 0);
    $("wc").innerHTML = step >= 2
      ? "本步 <b>" + wc + "</b> 词　·　全篇 <b>" + y.draft.words + "</b> 词（目标 150—165）"
      : "全篇 <b>" + y.draft.words + "</b> 词（目标 150—165）";
    const prev = $("prevBtn"), next = $("nextBtn");
    prev.disabled = step === 0;
    next.disabled = step === 5;
    next.textContent = step === 5 ? "已到底" : "下一步 →";
  }

  function renderOriginal() {
    const y = cur();
    const have = new Set(y.grades.map(g => g.key));
    $("gradebar").innerHTML = GRADES.map(([k, name]) => {
      const ok = have.has(k);
      return '<button class="gbtn' + (k === grade && ok ? " on" : "") + (ok ? "" : " off") + '" data-g="' + k + '"' + (ok ? "" : " disabled") + ">" + name + (ok ? "" : "（未取得）") + "</button>";
    }).join("");
    $("gradebar").querySelectorAll(".gbtn").forEach(b => {
      b.onclick = () => { if (!b.disabled) { grade = b.dataset.g; renderOriginal(); } };
    });
    const g = y.grades.find(x => x.key === grade) || y.grades[0];
    if (!g) { $("origlist").innerHTML = ""; $("origmeta").textContent = "本年份暂无原版数据。"; return; }
    const stat = y.grades.map(x => x.name + " " + x.words + " 词").join("　·　") + (have.has("simple") ? "" : "　·　简化版未取得");
    $("origmeta").innerHTML = "<b>" + g.name + "</b>　·　" + g.sentences.length + " 句　·　" + g.words + " 词　·　仅对照，不背（本站定稿 9 句 " + y.draft.words + " 词）<br><span style=\"color:var(--muted)\">四档实测：" + stat + "</span>";
    $("origlist").innerHTML = g.sentences.map(s =>
      '<div class="sent"><div class="top"><span class="no" style="background:var(--accent)">' + s.n + '</span><span class="p">P' + s.p + "</span><span>原版句</span></div>" +
      '<div class="en">' + s.en + "</div></div>"
    ).join("");
    let why = "<b>差异要记住：</b>原版是 9 句（P1 2 + P2 5 + P3 2）、180—215 词；本站定稿是南萧简化版 9 句（P1 2 + P2 5 + P3 3）、175—190 词。取它「一句话列全数据」的 P1，弃它五句套话堆出来的 P2。";
    why += "<br><b>三档怎么删：</b>满分 → 速通标准 → 无脑，句数都是 9 句，减的是每句里的政策/战略修饰和从句；到英语采用它的简化版，9 句 175—190 词，所以原版只能当语料和思路来源。";
    if (y.type === "B2") why += "<br><b>B2 特别提醒：</b>原版在静态多选柱状里用了 <code>respectively</code>，本站默认不写（各项合计 > 100%，不构成整体）；也不写 <code>The remaining X%</code>。";
    if (y.year === 2026) why += "<br><b>2026 数据口径：</b>原一页纸把 54.6% 写成“满足好奇心”、54.5% 写成“促进观察力”，与真题相反；本站按已核对口径：<b>促进观察力 54.6%、满足好奇心 54.5%</b>。";
    $("origwhy").innerHTML = why;
  }

  function renderMode() {
    document.querySelectorAll(".segbtn").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
    $("draftPane").hidden = mode !== "draft";
    $("originalPane").hidden = mode !== "original";
    $("modetip").textContent = mode === "draft"
      ? "默认路径：南萧简化版 9 句（2+5+3），175—190 词；逐步揭示，先自己写再对照。"
      : "原版 9 句、180—215 词，只用来对照思路和语料，不背。";
    if (mode === "original") renderOriginal();
  }

  function renderAll() {
    renderYears(); renderQ(); renderSteps(); renderStage(); renderMode();
  }

  document.querySelectorAll(".segbtn").forEach(b => {
    b.onclick = () => { mode = b.dataset.mode; renderMode(); };
  });
  $("prevBtn").onclick = () => { if (step > 0) { step--; renderStage(); } };
  $("nextBtn").onclick = () => { if (step < 5) { step++; if (step === 5) revealAll(); renderStage(); } };
  $("allBtn").onclick = () => { step = 5; revealAll(); renderStage(); };
  $("resetBtn").onclick = () => { step = 0; revealed.clear(); renderStage(); };
  $("copyBtn").onclick = async () => {
    const text = cur().draft.sentences.map(s => s.en).join(" ");
    try {
      await navigator.clipboard.writeText(text);
      $("copyBtn").textContent = "已复制 ✓";
      setTimeout(() => { $("copyBtn").textContent = "复制全文"; }, 1600);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (err) {}
      ta.remove();
      $("copyBtn").textContent = "已复制 ✓";
      setTimeout(() => { $("copyBtn").textContent = "复制全文"; }, 1600);
    }
  };
  $("printBtn").onclick = () => { step = 5; revealAll(); renderStage(); setTimeout(() => window.print(), 200); };
  $("themeBtn").onclick = () => {
    const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", now);
    $("themeBtn").textContent = now === "dark" ? "☀️" : "🌙";
    save();
  };
  if (document.documentElement.getAttribute("data-theme") === "dark") $("themeBtn").textContent = "☀️";

  renderAll();
})();
