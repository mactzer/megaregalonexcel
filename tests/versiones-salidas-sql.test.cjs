'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',X='44444444-4444-4444-8444-444444444444';
const ids=Array.from({length:10},(_,i)=>`88888888-8888-4888-8888-${String(i+1).padStart(12,'0')}`),tags=Array.from({length:7},(_,i)=>String(i+1).repeat(64)),numberTag='a'.repeat(64);
const cipher=Buffer.from('Fictional encrypted metadata for corrected salida versions').toString('base64'),review=Buffer.from('Fictional encrypted reason for choosing the corrected costs').toString('base64');
test('corrected salida versions enforce admin review and keep original files, identities and complete version history',async t=>{
 const db=new PGlite(),q=async(sql,args=[]) =>(await db.query(sql,args)).rows,scalar=async(sql,args=[])=>Object.values((await q(sql,args))[0])[0];
 const migration=fs.readFileSync(path.join(__dirname,'../supabase/versiones-salidas.sql'),'utf8');
 async function as(user,fn,role='authenticated'){await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec('set role '+role);try{return await fn();}finally{await db.exec('reset role');}}
 const call=(from,to,overrides={})=>scalar('select public.mega_audit_review_version($1,$2,$3,$4,$5,$6,$7,$8)',[W,ids[from],ids[to],overrides.fromTag||tags[from],overrides.toTag||tags[to],overrides.metadata||cipher,cipher,review]);
 const claim=(id,tag,existing=null)=>scalar('select public.mega_audit_operation_claim($1,$2,$2,$3,$4)',[W,tag,id,existing]);
 try{
  await db.exec(fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1]);
  for(const name of ['auditoria','consultas-operaciones','importaciones'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase',name+'.sql'),'utf8'));
  await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now()),($5,$6,now())',[A,'admin@usuarios.megaregalonexcel.invalid',U,'user@usuarios.megaregalonexcel.invalid',X,'outsider@usuarios.megaregalonexcel.invalid']);
  await q('update public.mega_audit_workspace set key_fingerprint=$1 where id=$2',[numberTag,W]);await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);
  for(let n=0;n<7;n++)await as(A,async()=>{
   const operation=n===6?'e'.repeat(64):tags[n];await scalar('select public.mega_audit_operation_claim($1,$2,$3,$4,null)',[W,operation,tags[n],ids[n]]);
   for(const kind of ['pdf','excel'])await q('insert into storage.objects(bucket_id,name,owner) values($1,$2,$3)',['mega-audit-documents',`${W}/${A}/${ids[n]}/${kind}.bin`,A]);
   await scalar('select public.mega_audit_record_v2($1,$2,$3,$4,$1,$5,$6)',[ids[n],W,n===4?'b'.repeat(64):numberTag,cipher,operation,tags[n]]);
  });
  await q("update public.mega_audit_records set document_kind='factura' where id=$1",[ids[5]]);
  const originals=await q('select id,created_by,created_at,encrypted_metadata,pdf_path,excel_path from public.mega_audit_records order by id'),files=await q('select * from storage.objects order by name');
  await t.test('installing twice preserves every row and file and grants no anonymous RPC',async()=>{
   await db.exec(migration);await db.exec(migration);assert.deepEqual(await q('select id,created_by,created_at,encrypted_metadata,pdf_path,excel_path from public.mega_audit_records order by id'),originals);assert.deepEqual(await q('select * from storage.objects order by name'),files);
   await as(null,()=>assert.rejects(call(0,1),e=>e.code==='42501'),'anon');
  });
  await t.test('members, outsiders, mismatched numbers, invoices, separate movements, altered tags and stale metadata are rejected',async()=>{
   for(const user of [U,X])await as(user,()=>assert.rejects(call(0,1),e=>e.code==='42501'));
   for(const [from,to,overrides] of [[0,4,{}],[0,5,{}],[6,1,{}],[0,1,{fromTag:'f'.repeat(64)}],[0,1,{metadata:review}]])await as(A,()=>assert.rejects(call(from,to,overrides),e=>e.code==='40001'));
   assert.equal((await q('select count(*)::int n from public.mega_audit_records where duplicate_of is not null'))[0].n,0);
  });
  await t.test('different PDF bytes can be confirmed as corrected versions, retry is idempotent and the active catalog excludes the old source',async()=>{
   const linked=await as(A,()=>call(0,1));assert.equal(linked.duplicate_of,ids[1]);assert.equal(linked.document_tag,tags[0]);assert.equal(linked.reviewed_by,A);assert.deepEqual(await as(A,()=>call(0,1)),linked);
   const active=await as(U,()=>q('select id from public.mega_audit_catalog_records where duplicate_of is null'));assert.ok(!active.some(r=>r.id===ids[0]));assert.ok(active.some(r=>r.id===ids[1]));
   assert.equal((await as(U,()=>claim(ids[7],tags[0]))).record.id,ids[0],'Retry returns the actual old PDF instead of another version with different bytes');
  });
  await t.test('legacy linked PDF can be reused without another upload or active record',async()=>{
   await q('delete from public.mega_audit_operations where record_id=$1',[ids[2]]);await q('update public.mega_audit_records set document_tag=null where id=$1',[ids[2]]);
   await as(A,()=>call(2,1));assert.equal((await as(U,()=>claim(ids[8],tags[2],ids[2]))).record.id,ids[2]);
  });
  await t.test('a third correction retains all preceding versions under one principal and protects concurrent decisions',async()=>{
   await as(A,()=>call(1,3));const links=await q('select id,duplicate_of from public.mega_audit_records where duplicate_of=$1 order by id',[ids[3]]);assert.deepEqual(links.map(r=>r.id),ids.slice(0,3));
   await as(A,()=>assert.rejects(call(0,1),e=>e.code==='40001'));
   assert.equal((await q('select count(*)::int n from public.mega_audit_records'))[0].n,7);
   assert.deepEqual(await q('select id,created_by,created_at,encrypted_metadata,pdf_path,excel_path from public.mega_audit_records order by id'),originals);assert.deepEqual(await q('select * from storage.objects order by name'),files);
  });
  await t.test('revoked administrator cannot retry a previously valid correction',async()=>{
   await q("update public.mega_audit_members set role='user' where user_id=$1",[A]);await as(A,()=>assert.rejects(call(1,3),e=>e.code==='42501'));
  });
 }finally{await db.close();}
});
