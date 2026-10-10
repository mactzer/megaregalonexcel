(function(root){
  'use strict';
  function connect(options){
    let socket, heartbeat, renewal, retry, watchdog, stopped=false, reference=0, attempts=0;
    const topic='realtime:mega-audit-'+options.workspace;
    const current=()=>!stopped&&options.isCurrent();
    function stopSocket(){clearInterval(heartbeat);clearInterval(renewal);clearTimeout(watchdog);if(socket){socket.onclose=null;socket.close();socket=null;}}
    function send(event,payload,channel=topic){if(socket&&socket.readyState===1)socket.send(JSON.stringify({topic:channel,event,payload,ref:String(++reference)}));}
    function reconnect(){if(!current())return;stopSocket();options.onStatus('polling');clearTimeout(retry);retry=setTimeout(start,Math.min(30000,1000*2**Math.min(attempts++,5)));}
    async function start(){
      if(!current())return;
      try{
        const token=await options.getAccessToken();if(!current())return;
        const url=new URL('/realtime/v1/websocket',options.url);url.protocol='wss:';url.searchParams.set('apikey',options.key);url.searchParams.set('vsn','1.0.0');
        socket=new root.WebSocket(url.toString());
        socket.onopen=()=>{
          if(!current())return stopSocket();
          send('phx_join',{config:{broadcast:{self:false},presence:{key:''},postgres_changes:[{event:'*',schema:'public',table:'mega_product_queries',filter:'workspace_id=eq.'+options.workspace},{event:'*',schema:'public',table:'mega_audit_records',filter:'workspace_id=eq.'+options.workspace}]},access_token:token});
          heartbeat=setInterval(()=>send('heartbeat',{},'phoenix'),25000);
          renewal=setInterval(async()=>{try{const next=await options.getAccessToken();if(current())send('access_token',{access_token:next});}catch(_){reconnect();}},30000);
          watchdog=setTimeout(reconnect,10000);
        };
        socket.onmessage=event=>{
          if(!current())return;
          let message;try{message=JSON.parse(event.data);}catch(_){return;}
          if(message.topic!==topic)return;
          if(message.event==='phx_reply'&&message.payload&&message.payload.response&&message.payload.response.postgres_changes){clearTimeout(watchdog);attempts=0;options.onStatus('live');options.onChange('all');}
          if(message.event==='phx_error'||message.event==='phx_close'||(message.event==='phx_reply'&&message.payload&&message.payload.status==='error'))return reconnect();
          const data=message.payload&&message.payload.data;
          if(message.event==='postgres_changes'&&data&&data.schema==='public'&&['mega_product_queries','mega_audit_records'].includes(data.table)&&data.record&&data.record.workspace_id===options.workspace)options.onChange(data.table);
        };
        socket.onerror=()=>{if(current())options.onStatus('polling');};socket.onclose=reconnect;
      }catch(_){reconnect();}
    }
    start();
    return Object.freeze({close(){stopped=true;clearTimeout(retry);stopSocket();}});
  }
  const api=Object.freeze({connect});if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.AuditRealtime=api;
})(typeof globalThis!=='undefined'?globalThis:this);
