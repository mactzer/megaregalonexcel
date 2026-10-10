'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Realtime=require('../audit-realtime.js');
test('Realtime uses one authenticated channel, checks workspace events, and stops heartbeats and late events on logout',async()=>{
 const original=global.WebSocket,sockets=[];let active=true;const changes=[],statuses=[];
 class FakeSocket{constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}send(value){this.sent.push(JSON.parse(value));}close(){this.readyState=3;this.closed=true;}}
 global.WebSocket=FakeSocket;
 const workspace='86551e44-7504-4d30-b453-c9e04b269a43';
 const connection=Realtime.connect({url:'https://example.invalid',key:'fictional-public-key',workspace,isCurrent:()=>active,getAccessToken:async()=> 'fictional-access-token',onChange:value=>changes.push(value),onStatus:value=>statuses.push(value)});
 try{
  await new Promise(setImmediate);assert.equal(sockets.length,1);const socket=sockets[0];assert.match(socket.url,/^wss:/);assert.ok(!socket.url.includes('access-token'));
  socket.readyState=1;socket.onopen();const join=socket.sent[0];assert.equal(join.event,'phx_join');assert.equal(join.payload.access_token,'fictional-access-token');assert.equal(join.payload.config.postgres_changes.length,2);
  const send=(event,payload)=>socket.onmessage({data:JSON.stringify({topic:join.topic,event,payload})});
  send('phx_reply',{status:'ok',response:{postgres_changes:[{id:1}]}});assert.deepEqual(statuses,['live']);assert.deepEqual(changes,['all']);
  send('postgres_changes',{data:{schema:'public',table:'mega_product_queries',record:{workspace_id:workspace}}});assert.deepEqual(changes,['all','mega_product_queries']);
  send('postgres_changes',{data:{schema:'public',table:'mega_product_queries',record:{workspace_id:'another-workspace'}}});send('postgres_changes',{data:{schema:'public',table:'another-table',record:{workspace_id:workspace}}});
  assert.equal(changes.length,2);active=false;connection.close();assert.equal(socket.closed,true);
  send('postgres_changes',{data:{schema:'public',table:'mega_audit_records',record:{workspace_id:workspace}}});assert.equal(changes.length,2);
 }finally{connection.close();global.WebSocket=original;}
});
