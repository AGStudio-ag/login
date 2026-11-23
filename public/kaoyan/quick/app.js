
(function(){
  var CARDS=window.QUICK_CARDS||[], KEY='ag_quick_remembered_v1';
  var state={cat:'all',q:'',mode:'wall',idx:0,flip:{},done:{},expandAll:false};
  function el(id){return document.getElementById(id);}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function load(){try{state.done=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(e){state.done={};}}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(state.done));}catch(e){}}
  function keyOf(c){return c.c+'||'+c.q;}
  function cats(){var o={},a=[];CARDS.forEach(function(c){if(!o[c.c]){o[c.c]=0;a.push(c.c);}o[c.c]++;});return {list:a,count:o};}
  function filtered(){
    var q=state.q.trim().toLowerCase();
    return CARDS.map(function(c,i){return {c:c,i:i};}).filter(function(o){
      return (state.cat==='all'||o.c.c===state.cat) &&
        (!q||(o.c.q+' '+o.c.a+' '+o.c.c).toLowerCase().indexOf(q)>=0);
    });
  }
  function doneCount(){var n=0;CARDS.forEach(function(c){if(state.done[keyOf(c)])n++;});return n;}

  function renderChips(){
    var cc=cats();
    el('qkChips').innerHTML='<button class="qk-chip'+(state.cat==='all'?' on':'')+'" data-c="all">全部 '+CARDS.length+'</button>'+
      cc.list.map(function(c){return '<button class="qk-chip'+(state.cat===c?' on':'')+'" data-c="'+esc(c)+'">'+esc(c)+' '+cc.count[c]+'</button>';}).join('');
  }
  function renderStats(){
    el('qkTotal').textContent=CARDS.length;
    el('qkDone').textContent=doneCount();
    el('qkCats').textContent=cats().list.length;
    el('qkShown').textContent=filtered().length;
  }
  function renderWall(){
    var arr=filtered();
    el('qkWall').classList.add('on');el('qkSingle').classList.remove('on');
    if(!arr.length){el('qkWall').innerHTML='<div class="qk-empty">没有匹配的卡片，换个关键词试试</div>';}
    else{
      el('qkWall').innerHTML=arr.map(function(o){
        var c=o.c,k=keyOf(c),open=state.expandAll||!!state.flip[k],done=!!state.done[k];
        return '<div class="qk-card'+(done?' done':'')+'" data-i="'+o.i+'">'+
          '<div class="cat">'+esc(c.c)+(done?' · 已记住':'')+'</div>'+
          '<div class="q">'+esc(c.q)+'</div>'+
          (open?'<div class="a">'+esc(c.a)+'</div><span class="src">来源：'+esc(c.s)+'</span>'
               :'<div class="hidden">轻点翻面看要点…</div>')+'</div>';
      }).join('');
    }
    el('qkInfo').textContent='显示 '+arr.length+' / '+CARDS.length+' 张 · 点卡片翻面 · 空格翻单卡';
  }
  function renderSingle(){
    var arr=filtered();
    el('qkWall').classList.remove('on');el('qkSingle').classList.add('on');
    if(!arr.length){el('qkSingle').innerHTML='<div class="qk-empty">没有匹配的卡片</div>';return;}
    if(state.idx>=arr.length)state.idx=0;
    var o=arr[state.idx],c=o.c,k=keyOf(c),open=!!state.flip[k],done=!!state.done[k];
    el('qkSingle').innerHTML='<div class="cat">'+esc(c.c)+(done?' · ✓ 已记住':'')+'</div>'+
      '<div class="q">'+esc(c.q)+'</div>'+
      (open?'<div class="a">'+esc(c.a)+'</div><span class="src">来源：'+esc(c.s)+'</span>'
           :'<div class="hidden">轻点卡片 / 按空格翻面…</div>');
    el('qkPos').textContent=(state.idx+1)+' / '+arr.length;
    el('qkDoneBtn').textContent=done?'✓ 已记住（点取消）':'标记已记住';
  }
  function render(){
    renderChips();renderStats();
    if(state.mode==='wall')renderWall();else renderSingle();
  }
  function toggleFlip(i){
    if(state.expandAll&&state.mode==='wall')return;
    var c=CARDS[i];if(!c)return;var k=keyOf(c);state.flip[k]=!state.flip[k];render();
  }
  function markDone(){
    var arr=filtered();if(!arr.length)return;
    var c=arr[state.idx].c,k=keyOf(c);
    if(state.done[k])delete state.done[k];else state.done[k]=1;
    save();render();
  }
  function move(d){var n=filtered().length;if(!n)return;state.idx=(state.idx+d+n)%n;state.flip={};render();}
  function rand(){var n=filtered().length;if(!n)return;state.idx=Math.floor(Math.random()*n);state.flip={};render();}
  function setMode(m){state.mode=m;state.flip={};state.idx=0;
    el('qkModeWall').classList.toggle('on',m==='wall');el('qkModeSingle').classList.toggle('on',m==='single');
    el('qkCtrl').style.display=m==='single'?'flex':'none';render();}

  function init(){
    load();
    el('qkQ').addEventListener('input',function(){state.q=this.value;state.idx=0;render();});
    el('qkChips').addEventListener('click',function(e){
      var b=e.target.closest('.qk-chip');if(!b)return;state.cat=b.getAttribute('data-c');state.idx=0;render();
    });
    el('qkWall').addEventListener('click',function(e){
      var c=e.target.closest('.qk-card');if(!c)return;toggleFlip(parseInt(c.getAttribute('data-i'),10));
    });
    el('qkSingle').addEventListener('click',function(){
      var arr=filtered();if(!arr.length)return;toggleFlip(arr[state.idx].i);
    });
    el('qkModeWall').addEventListener('click',function(){setMode('wall');});
    el('qkModeSingle').addEventListener('click',function(){setMode('single');});
    el('qkPrev').addEventListener('click',function(){move(-1);});
    el('qkNext').addEventListener('click',function(){move(1);});
    el('qkRand').addEventListener('click',rand);
    el('qkDoneBtn').addEventListener('click',markDone);
    el('qkClear').addEventListener('click',function(){
      if(!confirm('确定清空全部「已记住」标记？'))return;state.done={};save();render();
    });
    el('qkExpand').addEventListener('click',function(){
      state.expandAll=!state.expandAll;
      this.textContent=state.expandAll?'收起全部':'展开全部';
      if(state.mode!=='wall')setMode('wall');else render();
    });
    document.addEventListener('keydown',function(e){
      if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;
      if(e.code==='Space'){e.preventDefault();var arr=filtered();if(state.mode==='single'&&arr.length)toggleFlip(arr[state.idx].i);}
      if(e.key==='ArrowLeft')move(-1);
      if(e.key==='ArrowRight')move(1);
      if(e.key==='r'||e.key==='R')rand();
    });
    setMode('wall');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
