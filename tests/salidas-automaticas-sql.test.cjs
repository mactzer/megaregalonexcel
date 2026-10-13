'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',X='44444444-4444-4444-8444-444444444444';
const ids=Array.from({length:12},(_,i)=>`99999999-9999-4999-8999-${String(i+1).padStart(12,'0')}`),identity='a'.repeat(64),content1='b'.repeat(64),content2='c'.repeat(64),content3='d'.repeat(64),doc='e'.repeat(64),otherDoc='f'.repeat(64),numberTag='1'.repeat(64),cipher=Buffer.from('Fictional encrypted complete metadata for automatic salida tests').toString('base64');
test('automatic salida transactions preserve all versions and files, reject duplicate concurrent writes and enforce membership',async t=>{
 const db=new PGlite(),q=async(s,p=[]) =>(await db.query(s,p)).rows,scalar=async(s,p=[])=>Object.values((await q(s,p))[0])[0];
 async function as(user,work,role='authenticated'){await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec('set role '+role);try{return await work();}finally{await db.exec('reset role');}}
 const upload=async(user,id)=>{for(const kind of ['pdf','excel'])await q('insert into storage.objects(bucket_id,name,owner) values($1,$2,$3)',['mega-audit-documents',`${W}/${user}/${id}/${kind}.bin`,user]);};
 const prepare=(id,content=content3,document=otherDoc,group=identity)=>scalar('select public.mega_salida_prepare($1,$2,$3,$4,$5)',[W,group,content,document,id]);
 const commit=(id,content=content3,document=otherDoc,group=identity)=>scalar('select public.mega_salida_commit($1,$2,$3,$4,$5,$6,$7)',[W,group,content,document,id,numberTag,cipher]);
 const migration=fs.readFileSync(path.join(__dirname,'../supabase/salidas-automaticas.sql'),'utf8');
 try{
  await db.exec(fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1]);
  await db.exec('alter table storage.objects add column updated_at timestamptz default now()');
  for(const name of ['auditoria','precios','consultas-operaciones','importaciones','versiones-salidas'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase',name+'.sql'),'utf8'));
  await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now()),($5,$6,now())',[A,'admin@usuarios.megaregalonexcel.invalid',U,'user@usuarios.megaregalonexcel.invalid',X,'outsider@usuarios.megaregalonexcel.invalid']);await q('update public.mega_audit_workspace set key_fingerprint=$1 where id=$2',[identity,W]);await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);
  for(let i=0;i<3;i++)await as(A,async()=>{const tag=String(i+2).repeat(64);await scalar('select public.mega_audit_operation_claim($1,$2,$2,$3,null)',[W,tag,ids[i]]);await upload(A,ids[i]);await scalar('select public.mega_audit_record_v2($1,$2,$3,$4,$1,$5,$5)',[ids[i],W,numberTag,cipher,tag]);});
  for(let i=0;i<3;i++)await q("update public.mega_audit_records set created_at=$1::timestamptz where id=$2",['2026-10-'+String(8+i)+'T12:00:00Z',ids[i]]);
  const originals=await q('select id,created_by,created_at,encrypted_metadata,pdf_path,excel_path from public.mega_audit_records order by id'),files=await q('select * from storage.objects order by name');
  await t.test('migration is additive and repeatable and old tabs cannot create another normal salida',async()=>{
   await db.exec(migration);await db.exec(migration);assert.deepEqual(await q('select id,created_by,created_at,encrypted_metadata,pdf_path,excel_path from public.mega_audit_records order by id'),originals);assert.deepEqual(await q('select * from storage.objects order by name'),files);
   await as(U,async()=>{const tag='5'.repeat(64);await scalar('select public.mega_audit_operation_claim($1,$2,$2,$3,null)',[W,tag,ids[10]]);await upload(U,ids[10]);await assert.rejects(scalar('select public.mega_audit_record_v2($1,$2,$3,$4,$1,$5,$5)',[ids[10],W,numberTag,cipher,tag]),e=>e.code==='42501');});
   await as(A,()=>assert.rejects(scalar('select public.mega_audit_record_import($1,$2,$3,$4,$1,$5,$5,$6,true)',[ids[10],W,numberTag,cipher,'5'.repeat(64),'salida']),e=>e.code==='42501'&&/versiones automáticas/.test(e.message)));
  });
  await t.test('historical reprints are consolidated by verified content; a late copy of the original cannot replace the actual correction',async()=>{
   const entries=ids.slice(0,3).map((id,i)=>({id,encrypted_metadata:cipher,salida_tag:numberTag,document_tag:String(i+2).repeat(64),content_tag:i===1?content2:content1}));
   const result=await as(U,()=>scalar('select public.mega_salida_seed($1,$2,$3)',[W,identity,JSON.stringify(entries)]));assert.equal(result.current_record_id,ids[1]);assert.equal(result.version,2);
   const records=await q('select id,salida_version,duplicate_of from public.mega_audit_records where salida_identity_tag=$1 order by id',[identity]);assert.deepEqual(records.map(r=>r.salida_version),[1,2,1]);assert.equal(records.filter(r=>!r.duplicate_of).length,1);
   assert.deepEqual(await q('select id,created_by,created_at,encrypted_metadata,pdf_path,excel_path from public.mega_audit_records order by id'),originals);
   const reused=await as(A,()=>prepare(ids[3],content1,doc));assert.equal(reused.action,'existing');assert.equal(reused.record.id,ids[1]);assert.equal(reused.matched_record.salida_version,1);
  });
  await t.test('two authorized users interleave registration: one reservation, one commit, and the other reuses that version',async()=>{
   const reserved=await as(A,()=>prepare(ids[3]));assert.equal(reserved.version,3);await as(U,()=>assert.rejects(prepare(ids[4]),e=>e.code==='40001'));
   await as(A,()=>upload(A,ids[3]));const saved=await as(A,()=>commit(ids[3]));assert.equal(saved.salida_version,3);assert.equal(saved.created_by,A);assert.deepEqual(await as(A,()=>commit(ids[3])),saved);
   const reused=await as(U,()=>prepare(ids[4]));assert.equal(reused.action,'existing');assert.equal(reused.record.id,ids[3]);assert.equal((await q('select count(*)::int n from public.mega_audit_records where salida_identity_tag=$1 and duplicate_of is null',[identity]))[0].n,1);
   await as(A,()=>assert.rejects(scalar('select public.mega_audit_import_update($1,$2,$3,$3,$4,$5,$6)',[W,ids[3],cipher,numberTag,'salida',ids[9]]),e=>e.code==='42501'));
   assert.equal((await q('select count(*)::int n from public.mega_audit_records where salida_identity_tag=$1',[identity]))[0].n,4);
  });
  await t.test('different contexts and restored abandoned leases remain independent; a stale writer cannot commit',async()=>{
   const group='6'.repeat(64),content='7'.repeat(64);await as(A,()=>prepare(ids[5],content,doc,group));await q("update public.mega_salidas set pending_at=clock_timestamp()-interval '3 minutes' where identity_tag=$1",[group]);
   await as(U,()=>prepare(ids[6],content,otherDoc,group));await as(A,()=>assert.rejects(commit(ids[5],content,doc,group),e=>e.code==='40001'));await as(U,()=>upload(U,ids[6]));const saved=await as(U,()=>commit(ids[6],content,otherDoc,group));assert.equal(saved.salida_version,1);assert.equal(saved.duplicate_of,null);
   assert.equal((await q('select count(*)::int n from public.mega_audit_records where duplicate_of is null'))[0].n,2);
  });
  await t.test('complete backup restores every version exactly; an older backup restores missing history without replacing a later correction',async()=>{
   const snapshot=()=>scalar('select public.mega_audit_backup_snapshot($1)',[W]);
   const backup=await as(A,snapshot);assert.equal(backup.tables.mega_salidas.length,2);
   const restore=data=>{const result=spawnSync('python3',['-c',"import importlib.util,sys,json;s=importlib.util.spec_from_file_location('restore','tools/restore-megacontrol.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.restore_sql(json.load(sys.stdin)))"],{cwd:path.resolve(__dirname,'..'),input:JSON.stringify(data),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
   await db.exec('truncate public.mega_salidas,public.mega_audit_records,public.mega_audit_operations');await db.exec(restore(backup));await db.exec(restore(backup));assert.deepEqual((await as(A,snapshot)).tables,backup.tables);assert.deepEqual((await as(A,snapshot)).objects,backup.objects);
   const fresh='9'.repeat(64);await as(A,()=>prepare(ids[8],fresh,doc));await as(A,()=>upload(A,ids[8]));const latest=await as(A,()=>commit(ids[8],fresh,doc));assert.equal(latest.salida_version,4);
   await q('delete from public.mega_audit_operations where record_id=$1',[ids[2]]);await q('delete from public.mega_audit_records where id=$1',[ids[2]]);const before=await q('select to_jsonb(r) as data from public.mega_audit_records r where id=$1',[ids[8]]);
   await db.exec(restore(backup));assert.deepEqual(await q('select to_jsonb(r) as data from public.mega_audit_records r where id=$1',[ids[8]]),before);
   assert.equal((await q('select current_record_id from public.mega_salidas where identity_tag=$1',[identity]))[0].current_record_id,ids[8]);assert.equal((await q('select duplicate_of from public.mega_audit_records where id=$1',[ids[2]]))[0].duplicate_of,ids[8]);assert.equal((await q('select count(*)::int n from public.mega_audit_records where salida_identity_tag=$1 and duplicate_of is null',[identity]))[0].n,1);
  });
  await t.test('anonymous users, outsiders, direct mutation, stale proof and revoked membership cannot change identity or history',async()=>{
   for(const user of [null,X])await as(user,()=>assert.rejects(prepare(ids[7]),e=>e.code==='42501'),user?'authenticated':'anon');
   await db.exec('grant select,insert,update,delete on public.mega_salidas to authenticated,anon;create policy accidental on public.mega_salidas for all to authenticated,anon using(true) with check(true)');
   assert.deepEqual(await as(X,()=>q('select * from public.mega_salidas')),[]);assert.deepEqual(await as(A,()=>q('delete from public.mega_salidas returning *')),[]);
   const bad=[{id:ids[1],encrypted_metadata:Buffer.from('Incorrect proof').toString('base64'),salida_tag:numberTag,document_tag:doc,content_tag:content1}];await as(U,()=>assert.rejects(scalar('select public.mega_salida_seed($1,$2,$3)',[W,'8'.repeat(64),JSON.stringify(bad)]),e=>e.code==='40001'));
   await q('delete from public.mega_audit_members where user_id=$1',[U]);await as(U,()=>assert.rejects(prepare(ids[7]),e=>e.code==='42501'));
  });
 }finally{await db.close();}
});
