'use strict';
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222';
function store(){return {messages:new Map(),cases:new Map(),products:new Map(),events:[],notifications:[],followers:new Map(),sockets:new Set(),seq:0,notice:0};}
async function handle({state,url,request,json,route}){
 const path=url.pathname;if(!/\/mega_chat_/.test(path))return false;const db=state.chat;
 const broadcast=table=>{for(const socket of db.sockets)socket.send(JSON.stringify({topic:'realtime:mega-audit-'+W,event:'postgres_changes',payload:{data:{schema:'public',table,record:{workspace_id:W}}}}));};
 const notif=(id,kind,revision=0)=>{for(const user of [A,U])if(user!==state.actor){db.notifications.push({id:++db.notice,workspace_id:W,user_id:user,message_id:id,kind,revision,created_at:new Date().toISOString(),read_at:null});}broadcast('mega_chat_notifications');};
 if(state.noMembership){await json({code:'42501'},403);return true;}
 if(state.chatFail){await json({code:'fictional_error'},503);return true;}
 if(path.endsWith('mega_chat_members')){await json([{id:A,username:'administrador',role:'admin'},{id:U,username:'colega',role:'user'}]);return true;}
 const body=request.method()==='POST'?request.postDataJSON():null;
 if(path.endsWith('mega_chat_send')){
  let row=db.messages.get(body.p_id);if(!row){row={id:body.p_id,workspace_id:W,seq:++db.seq,kind:body.p_kind,encrypted_body:body.p_body,parent_id:body.p_parent||null,created_by:state.actor,created_at:new Date().toISOString()};db.messages.set(row.id,row);notif(row.id,body.p_mentions?.includes(state.actor===A?U:A)?'mention':row.parent_id?'reply':'message');broadcast('mega_chat_messages');}
  if(state.dropChatResponse){await route.abort('failed');return true;}await json(row);return true;
 }
 if(path.endsWith('mega_chat_case_open')){
  let c=[...db.cases.values()].find(c=>c.product_tag===body.p_tag&&['pending','in_progress'].includes(c.status));
  if(!c){const now=new Date().toISOString();c={id:body.p_id,workspace_id:W,product_tag:body.p_tag,status:'pending',revision:0,assigned_to:null,updated_by:state.actor,updated_at:now};db.cases.set(c.id,c);db.messages.set(c.id,{id:c.id,workspace_id:W,seq:++db.seq,kind:'case',encrypted_body:body.p_body,parent_id:null,case_id:c.id,created_by:state.actor,created_at:now});notif(c.id,'case');broadcast('mega_chat_messages');}
  if(!db.followers.has(c.id))db.followers.set(c.id,new Set());db.followers.get(c.id).add(state.actor);broadcast('mega_chat_cases');await json(c);return true;
 }
 if(path.endsWith('mega_chat_case_follow')){if(!db.followers.has(body.p_id))db.followers.set(body.p_id,new Set());db.followers.get(body.p_id).add(state.actor);await json(true);return true;}
 if(path.endsWith('mega_chat_case_update')){
  if(state.role!=='admin'){await json({code:'42501'},403);return true;}const c=db.cases.get(body.p_id);if(c.revision!==body.p_expected){if(c.revision===body.p_expected+1&&c.encrypted_resolution===body.p_resolution){await json(c);return true;}await json({code:'40001'},409);return true;}
  Object.assign(c,{status:body.p_status,assigned_to:body.p_assigned,encrypted_resolution:body.p_resolution,updated_by:state.actor,updated_at:new Date().toISOString(),revision:c.revision+1});db.events.push({workspace_id:W,case_id:c.id,revision:c.revision,status:c.status,assigned_to:c.assigned_to,encrypted_resolution:c.encrypted_resolution,changed_by:state.actor,created_at:c.updated_at});notif(c.id,c.status==='resolved'?'resolved':'status',c.revision);broadcast('mega_chat_cases');await json(c);return true;
 }
 if(path.endsWith('mega_chat_product_put')){
  if(state.role!=='admin'){await json({code:'42501'},403);return true;}let old=db.products.get(body.p_tag);if(old&&old.version!==body.p_expected){if(old.version===body.p_expected+1&&old.encrypted_product===body.p_product){await json(old);return true;}await json({code:'40001'},409);return true;}
  const row={workspace_id:W,product_tag:body.p_tag,version:body.p_expected+1,encrypted_product:body.p_product,updated_by:state.actor,updated_at:new Date().toISOString()};db.products.set(body.p_tag,row);broadcast('mega_chat_products');await json(row);return true;
 }
 if(path.endsWith('mega_chat_read')){for(const item of db.notifications)if(item.user_id===state.actor&&(body.p_only?item.id===body.p_through:item.id<=body.p_through))item.read_at=new Date().toISOString();await json(true);return true;}
 if(path.endsWith('mega_chat_image_prepare')){await json({path:W+'/'+state.actor+'/'+body.p_id+'/image.bin'});return true;}
 let rows;
 const table=path.split('mega_chat_')[1],eq=key=>(url.searchParams.get(key)||'').replace(/^eq\./,'');
 if(table==='messages')rows=[...db.messages.values()].filter(r=>(!eq('id')||r.id===eq('id'))&&(!eq('parent_id')||r.parent_id===eq('parent_id')));
 else if(table==='cases')rows=[...db.cases.values()].filter(r=>!eq('id')||eq('id').startsWith('in.')?(!eq('id')||eq('id').includes(r.id)):r.id===eq('id'));
 else if(table==='products')rows=[...db.products.values()].filter(r=>!eq('product_tag')||r.product_tag===eq('product_tag'));
 else if(table==='notifications')rows=db.notifications.filter(r=>r.user_id===state.actor&&!r.read_at);
 else if(table==='case_events')rows=db.events.filter(r=>r.case_id===eq('case_id'));
 else throw new Error('Chat mock route missing: '+path);
 const seq=url.searchParams.get('seq');if(seq){const [op,num]=seq.split('.');rows=rows.filter(r=>op==='lt'?r.seq<Number(num):r.seq>Number(num));}
 const stat=url.searchParams.get('status');if(stat)rows=rows.filter(r=>stat.startsWith('in.')?stat.includes(r.status):r.status===stat.slice(3));
 const rev=url.searchParams.get('revision');if(rev)rows=rows.filter(r=>r.revision<Number(rev.slice(3)));
 const order=url.searchParams.get('order')||'';if(order.startsWith('seq.'))rows.sort((a,b)=>order==='seq.asc'?a.seq-b.seq:b.seq-a.seq);if(order.startsWith('id.desc'))rows.sort((a,b)=>b.id-a.id);if(order.startsWith('revision.desc'))rows.sort((a,b)=>b.revision-a.revision);if(order.startsWith('updated_at'))rows.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
 await json(rows.slice(0,Number(url.searchParams.get('limit')||100)));return true;
}
module.exports={store,handle};
