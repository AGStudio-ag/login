/* 隔离版本地同步：仅写本机 localStorage，不发起任何网络请求 */
(function(){
  var KEY='__kaoyan_local_state__';
  function read(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){return {}}}
  function write(o){try{localStorage.setItem(KEY,JSON.stringify(o))}catch(e){}}
  window.__LOCAL_SYNC__=true;
  window.KaoyanSync={
    save:function(k,v){var s=read();s[k]=v;write(s);},
    load:function(k){return read()[k];},
    push:function(){return Promise.resolve({ok:true,local:true});},
    pull:function(){return Promise.resolve({ok:true,local:true});},
    state:function(){return read();}
  };
})();
