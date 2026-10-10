'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',X='44444444-4444-4444-8444-444444444444';
const ids=Array.from({length:8},(_,i)=>`77777777-7777-4777-8777-${String(i+1).padStart(12,'0')}`),tag='a'.repeat(64),doc='b'.repeat(64),secondDoc='c'.repeat(64);
const encrypted=Buffer.from('Fictional encrypted payload for database security tests').toString('base64');
test('shared query persistence and operation identity are enforced in PostgreSQL without deleting historical records',async t=>{
 const db=new PGlite(),q=async(sql,args=[]) => (await db.query(sql,args)).rows,scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const bootstrap=fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1];
 const migration=fs.readFileSync(path.join(__dirname,'../supabase/consultas-operaciones.sql'),'utf8');
 async function as(user,work,role='authenticated'){await db.exec('reset role');await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec(`set role ${role}`);try{return await work();}finally{await db.exec('reset role');}}
 const denied=(work,code='42501')=>assert.rejects(work,e=>e.code===code);
 const claim=(id,operation=doc,document=doc,existing=null)=>scalar('select public.mega_audit_operation_claim($1,$2,$3,$4,$5)',[W,operation,document,id,existing]);
 const save=(id,operation=doc,document=doc)=>scalar('select public.mega_audit_record_v2($1,$2,$3,$4,$1,$5,$6)',[id,W,tag,encrypted,operation,document]);
 const upload=async(user,id)=>{for(const kind of ['pdf','excel'])await q('insert into storage.objects(bucket_id,name,owner) values($1,$2,$3)',['mega-audit-documents',`${W}/${user}/${id}/${kind}.bin`,user]);};
 const queryAdd=(id,payload=encrypted)=>scalar('select public.mega_product_query_add($1,$2,$3)',[W,id,payload]);
 try{
  await db.exec(bootstrap);await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/auditoria.sql'),'utf8'));
  for(const [id,name] of [[A,'admin'],[U,'colega'],[X,'externo']])await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,name+'@usuarios.megaregalonexcel.invalid']);
  await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);await q('update public.mega_audit_workspace set key_fingerprint=$1 where id=$2',[tag,W]);
  // Seed two legacy attempts BEFORE applying the additive migration.
  await as(A,async()=>{for(const id of ids.slice(0,2)){await upload(A,id);await scalar('select public.mega_audit_record($1,$2,$3,$4,$1)',[id,W,tag,encrypted]);}});
  await db.exec(migration);
  await t.test('migration preserves both legacy rows and all documents; running it twice is safe',async()=>{
   await db.exec(migration);assert.equal((await q('select count(*)::int as n from public.mega_audit_records'))[0].n,2);assert.equal((await q('select count(*)::int as n from storage.objects'))[0].n,4);
   assert.equal((await q('select count(*)::int as n from public.mega_audit_records where duplicate_of is not null'))[0].n,0);
  });
  await t.test('query A persists, B reads it, retries use one official ID/time, outsiders and direct writes are denied',async()=>{
   const saved=await as(A,()=>queryAdd(ids[2]));assert.equal(saved.created_by,A);assert.ok(Date.parse(saved.created_at));
   assert.deepEqual(await as(A,()=>queryAdd(ids[2])),saved);
   assert.equal((await as(U,()=>q('select * from public.mega_product_queries'))).length,1);
   await as(U,()=>denied(()=>queryAdd(ids[2]),'23505'));await as(A,()=>denied(()=>queryAdd(ids[2],Buffer.from('Another fictional encrypted result').toString('base64')),'23505'));
   assert.deepEqual(await as(X,()=>q('select * from public.mega_product_queries')),[]);await as(X,()=>denied(()=>queryAdd(ids[3])));await as(null,()=>denied(()=>queryAdd(ids[3])),'anon');
   for(const sql of ['delete from public.mega_product_queries','update public.mega_product_queries set created_by=\''+U+'\'','truncate public.mega_product_queries'])await as(A,()=>denied(()=>q(sql)));
  });
  await t.test('one reservation survives different attempts/accounts; commit is unique and caller cannot skip reservation',async()=>{
   await as(A,()=>claim(ids[3]));await as(U,()=>denied(()=>claim(ids[4]),'40001'));
   await as(A,()=>denied(()=>scalar('select public.mega_audit_record($1,$2,$3,$4,$1)',[ids[3],W,tag,encrypted])));
   await as(A,async()=>{await upload(A,ids[3]);const saved=await save(ids[3]);assert.equal(saved.document_tag,doc);assert.equal(saved.operation_kind,'primary');assert.deepEqual(await save(ids[3]),saved);});
   const reused=await as(U,()=>claim(ids[4]));assert.equal(reused.record.id,ids[3]);
   assert.equal((await q('select count(*)::int as n from public.mega_audit_records'))[0].n,3);
   await as(X,()=>denied(()=>claim(ids[4])));
  });
  await t.test('different documents with equal product fields and explicit second movements remain separate',async()=>{
   await as(U,async()=>{await claim(ids[4],secondDoc,secondDoc);await upload(U,ids[4]);await save(ids[4],secondDoc,secondDoc);
    const separate='d'.repeat(64);await claim(ids[5],separate,doc);await upload(U,ids[5]);const row=await save(ids[5],separate,doc);assert.equal(row.operation_kind,'separate');});
   assert.equal((await q('select count(*)::int as n from public.mega_audit_records'))[0].n,5);
  });
  await t.test('abandoned uncommitted reservations can be reclaimed; stale upload cannot commit another record',async()=>{
   const operation='e'.repeat(64);await as(A,()=>claim(ids[6],operation,secondDoc));await q("update public.mega_audit_operations set reserved_at=clock_timestamp()-interval '3 minutes' where operation_tag=$1",[operation]);
   await as(U,()=>claim(ids[7],operation,secondDoc));await as(A,()=>denied(()=>save(ids[6],operation,secondDoc),'40001'));
  });
  await t.test('only admins can confirm historical duplicates; linked originals remain readable, separate movements are protected',async()=>{
   const review=(id,canonical)=>scalar('select public.mega_audit_review_duplicate($1,$2,$3,$4,$5)',[W,id,canonical,doc,encrypted]);
   await as(U,()=>denied(()=>review(ids[1],ids[0])));await as(A,()=>denied(()=>review(ids[5],ids[0]),'40001'));
   const linked=await as(A,()=>review(ids[1],ids[0]));assert.equal(linked.duplicate_of,ids[0]);assert.equal(linked.reviewed_by,A);
   assert.equal((await q('select count(*)::int as n from public.mega_audit_records'))[0].n,5);
   assert.equal((await as(U,()=>q('select * from public.mega_audit_records where id=$1',[ids[1]]))).length,1);
   assert.equal((await q('select count(*)::int as n from storage.objects'))[0].n,10);
   assert.equal((await as(U,()=>claim(ids[2],doc,doc,ids[0]))).record.id,ids[3],'A committed identity cannot be rebound by a later attempt');
  });
  await t.test('revocation blocks pending query writes and restrictive policies resist broad accidental grants',async()=>{
   await db.exec('grant select,insert,update,delete on public.mega_product_queries,public.mega_audit_operations to authenticated,anon;create policy accidental_query_access on public.mega_product_queries for all to authenticated,anon using(true) with check(true)');
   assert.deepEqual(await as(X,()=>q('select * from public.mega_product_queries')),[]);
   assert.deepEqual(await as(A,()=>q('delete from public.mega_product_queries returning *')),[]);
   await q('delete from public.mega_audit_members where user_id=$1',[U]);await as(U,()=>denied(()=>queryAdd(ids[7])));await as(U,()=>denied(()=>claim(ids[7])));
  });
 }finally{await db.close();}
});
