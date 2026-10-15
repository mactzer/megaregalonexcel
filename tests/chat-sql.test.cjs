'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',X='44444444-4444-4444-8444-444444444444',ID='99999999-9999-4999-8999-000000000001',REPLY='99999999-9999-4999-8999-000000000002',CASE='99999999-9999-4999-8999-000000000003',IMAGE='99999999-9999-4999-8999-000000000004',TAG='a'.repeat(64),cipher=Buffer.from('Fictional ciphertext only for chat database security tests').toString('base64');
test('product chat: actual PostgreSQL permissions, shared persistence, versioned resolutions, idempotency and bounded private images',async t=>{
 const db=new PGlite(),q=async(s,p=[]) =>(await db.query(s,p)).rows,scalar=async(s,p=[])=>Object.values((await q(s,p))[0])[0],sql=name=>fs.readFileSync(path.join(__dirname,'../supabase',name+'.sql'),'utf8');
 async function as(user,work,role='authenticated'){await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec('set role '+role);try{return await work();}finally{await db.exec('reset role');}}
 const send=(id=ID,parent=null,kind='text')=>scalar('select public.mega_chat_send($1,$2,$3,$4,$5,$6)',[W,id,kind,cipher,parent,[A]]);
 const open=(id=CASE)=>scalar('select public.mega_chat_case_open($1,$2,$3,$4)',[W,id,TAG,cipher]);
 const update=(expected,status='in_progress')=>scalar('select public.mega_chat_case_update($1,$2,$3,$4,$5,$6)',[W,CASE,expected,status,A,cipher]);
 try{
  await db.exec(fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1]);await db.exec('alter table storage.objects add column updated_at timestamptz default now()');
  for(const name of ['auditoria','precios','consultas-operaciones','importaciones','versiones-salidas','salidas-automaticas','eficiencia','chat-productos'])await db.exec(sql(name));
  await db.exec(sql('chat-productos'));
  for(const [id,name]of [[A,'admin'],[U,'worker'],[X,'outsider']])await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,name+'@usuarios.megaregalonexcel.invalid']);
  await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);
  await q('update public.mega_audit_workspace set key_fingerprint=$1 where id=$2',[TAG,W]);
  await t.test('messages persist with official author/time, replies are linked, repeated sends do not duplicate notifications',async()=>{
   const team=await as(U,()=>scalar('select public.mega_chat_members($1)',[W]));assert.equal(team.length,2);assert.equal(team.find(m=>m.id===A).username,'admin');
   const m=await as(U,()=>send());assert.equal(m.created_by,U);assert.equal(m.kind,'text');assert.ok(m.created_at);
   assert.deepEqual(await as(U,()=>send()),m);assert.equal((await as(A,()=>q('select * from public.mega_chat_messages'))).length,1);
   const reply=await as(A,()=>send(REPLY,ID));assert.equal(reply.parent_id,ID);
   assert.equal((await as(A,()=>q('select * from public.mega_chat_notifications'))).length,1);assert.equal((await as(U,()=>q('select * from public.mega_chat_notifications'))).length,1);
   await as(X,()=>assert.rejects(send(),e=>e.code==='42501'));assert.deepEqual(await as(X,()=>q('select * from public.mega_chat_messages')),[]);
   await as(U,()=>assert.rejects(scalar('select public.mega_chat_send($1,$2,$3,$4)',[W,ID,'text',Buffer.from('Other different fictional cipher').toString('base64')]),e=>e.code==='23505'));
  });
  await t.test('a code has exactly one open case; users join it, only admins assign or resolve and events retain earlier states',async()=>{
   const c=await as(U,()=>open());assert.equal(c.status,'pending');const duplicate=await as(A,()=>open('99999999-9999-4999-8999-000000000005'));assert.equal(duplicate.id,CASE);
   assert.equal((await q('select * from public.mega_chat_followers')).length,2);
   await as(U,()=>assert.rejects(update(0),e=>e.code==='42501'));const progress=await as(A,()=>update(0));assert.equal(progress.assigned_to,A);assert.equal(progress.revision,1);
   assert.deepEqual(await as(A,()=>update(0)),progress);await as(A,()=>assert.rejects(update(0,'resolved'),e=>e.code==='40001'));
   const resolved=await as(A,()=>update(1,'resolved'));assert.equal(resolved.status,'resolved');assert.equal((await q('select * from public.mega_chat_case_events')).length,2);
   const notices=await as(U,()=>q("select * from public.mega_chat_notifications where kind='resolved'"));assert.equal(notices.length,1);
   const next=await as(U,()=>open('99999999-9999-4999-8999-000000000006'));assert.notEqual(next.id,CASE);
  });
  await t.test('product registration/associations are admin-only, revision-checked and immutable in history',async()=>{
   const put=expected=>scalar('select public.mega_chat_product_put($1,$2,$3,$4)',[W,TAG,expected,cipher]);
   await as(U,()=>assert.rejects(put(0),e=>e.code==='42501'));const first=await as(A,()=>put(0));assert.equal(first.version,1);assert.deepEqual(await as(A,()=>put(0)),first);
   const second=await as(A,()=>put(1));assert.equal(second.version,2);assert.equal((await q('select * from public.mega_chat_product_events')).length,2);
   await as(A,()=>assert.rejects(put(0),e=>e.code==='40001'));
  });
  await t.test('image upload uses reserved bounded paths; no overwrite or deletion and no send before the real object exists',async()=>{
   const prepare=size=>scalar('select public.mega_chat_image_prepare($1,$2,$3)',[W,IMAGE,size]);await as(U,()=>assert.rejects(prepare(170000),e=>e.code==='22023'));const f=await as(U,()=>prepare(120));
   await as(A,()=>assert.rejects(prepare(120),e=>e.code==='23505'));await as(U,()=>assert.rejects(send(IMAGE,null,'image'),e=>e.code==='22023'));
   await as(X,()=>assert.rejects(q('insert into storage.objects(bucket_id,name,owner,metadata) values($1,$2,$3,$4)',['mega-chat-images',f.path,X,{size:120}]),e=>e.code==='42501'));
   await as(U,()=>q('insert into storage.objects(bucket_id,name,owner,metadata) values($1,$2,$3,$4)',['mega-chat-images',f.path,U,{size:120}]));
   await as(U,()=>send(IMAGE,null,'image'));assert.deepEqual(await as(U,()=>q("delete from storage.objects where bucket_id='mega-chat-images' returning *")),[]);
   assert.deepEqual(await as(X,()=>q("select * from storage.objects where bucket_id='mega-chat-images'")),[]);assert.equal((await as(A,()=>q("select * from storage.objects where bucket_id='mega-chat-images'"))).length,1);
  });
  await t.test('backup snapshot includes full chat, original decision events and private image inventory, and migration is repeatable',async()=>{
   const backup=await as(A,()=>scalar('select public.mega_audit_backup_snapshot($1)',[W]));assert.equal(backup.tables.mega_chat_messages.length,5);assert.equal(backup.tables.mega_chat_case_events.length,2);assert.equal(backup.tables.mega_chat_products.length,1);assert.equal(backup.objects.length,1);assert.equal(backup.objects[0].bucket,'mega-chat-images');
   await as(U,()=>assert.rejects(scalar('select public.mega_audit_backup_snapshot($1)',[W]),e=>e.code==='42501'));await db.exec(sql('chat-productos'));assert.equal((await q('select * from public.mega_chat_messages')).length,5);
  });
  await t.test('full recovery restores missing chat data and retains newer identifiers without identity sequence collisions',async()=>{
   const backup=await as(A,()=>scalar('select public.mega_audit_backup_snapshot($1)',[W]));
   const script="import importlib.util,json,sys; s=importlib.util.spec_from_file_location('restore','tools/restore-megacontrol.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.restore_sql(json.load(sys.stdin)))";
   const result=require('node:child_process').spawnSync('python3',['-c',script],{cwd:path.join(__dirname,'..'),input:JSON.stringify(backup),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
   await db.exec('begin;delete from public.mega_chat_notifications;delete from public.mega_chat_product_events;delete from public.mega_chat_products;delete from public.mega_chat_case_events;delete from public.mega_chat_followers;delete from public.mega_chat_cases;delete from public.mega_chat_files;delete from public.mega_chat_messages;commit;');await db.exec(result.stdout);
   assert.equal((await q('select * from public.mega_chat_messages')).length,5);assert.equal((await q('select * from public.mega_chat_case_events')).length,2);assert.equal((await q('select * from public.mega_chat_products')).length,1);
   await db.exec(result.stdout);assert.equal((await q('select * from public.mega_chat_messages')).length,5);
  });
  await t.test('restrictive guards block accidental broad grants; anonymous and revoked users cannot access messages or RPCs',async()=>{
   for(const table of ['mega_chat_messages','mega_chat_cases','mega_chat_products','mega_chat_notifications','mega_chat_case_events']){await db.exec('grant all on public.'+table+' to anon,authenticated;create policy too_broad on public.'+table+' for all to anon,authenticated using(true) with check(true)');assert.deepEqual(await as(A,()=>q('delete from public.'+table+' returning *')),[]);assert.deepEqual(await as(X,()=>q('select * from public.'+table)),[]);assert.deepEqual(await as(null,()=>q('select * from public.'+table),'anon'),[]);}
   await q('delete from public.mega_audit_members where user_id=$1',[A]);await as(A,()=>assert.rejects(update(2),e=>e.code==='42501'));assert.deepEqual(await as(A,()=>q('select * from public.mega_chat_messages')),[]);const former=await as(U,()=>scalar('select public.mega_chat_members($1)',[W]));assert.equal(former.find(m=>m.id===A).role,'former');
  });
 }finally{await db.close();}
});
