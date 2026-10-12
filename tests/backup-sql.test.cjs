'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',X='44444444-4444-4444-8444-444444444444',R='33333333-3333-4333-8333-333333333333';
const ROOT=path.resolve(__dirname,'..');
test('backup SQL: admin-only atomic snapshot, complete scope, additive migration and actual database restoration',async t=>{
 const db=new PGlite(),q=async(s,p=[]) =>(await db.query(s,p)).rows;
 const snapshot=async()=> (await q('select public.mega_audit_backup_snapshot($1) as data',[W]))[0].data;
 async function as(id,fn,role='authenticated') {await q("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);try{return await fn();}finally{await db.exec('reset role');}}
 try {
  await db.exec(fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1]);
  await db.exec('alter table storage.objects add column updated_at timestamptz default now()');
  for(const name of ['auditoria','precios','consultas-operaciones','respaldos'])await db.exec(fs.readFileSync(path.join(ROOT,'supabase',name+'.sql'),'utf8'));
  await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now()),($5,$6,now())',[A,'admin@usuarios.megaregalonexcel.invalid',U,'colega@usuarios.megaregalonexcel.invalid',X,'otro@usuarios.megaregalonexcel.invalid']);
  await q("update public.mega_audit_workspace set key_fingerprint=$1,label=$2 where id=$3",['a'.repeat(64),"Mega $mega_restore$ ' ; texto \\ de prueba",W]);
  await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);
  const cipher=Buffer.from('Contenido cifrado ficticio para respaldos').toString('base64');
  await q('insert into public.mega_audit_user_keys(workspace_id,user_id,wrapped_key) values($1,$2,$3),($1,$4,$3)',[W,A,cipher,U]);
  await q('select set_config(\'request.jwt.claim.sub\',$1,false)',[A]);
  for(const kind of ['pdf','excel'])await q('insert into storage.objects(bucket_id,name,owner,metadata) values($1,$2,$3,$4)', ['mega-audit-documents',`${W}/${A}/${R}/${kind}.bin`,A,{size:40}]);
  // This record predates the reservation schema: preserve legacy records too.
  await db.exec('alter table public.mega_audit_records disable trigger mega_audit_operation_guard');
  await q('insert into public.mega_audit_records(id,workspace_id,created_by,salida_tag,encrypted_metadata,pdf_path,excel_path,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$1)',[R,W,A,'b'.repeat(64),cipher,`${W}/${A}/${R}/pdf.bin`,`${W}/${A}/${R}/excel.bin`]);
  await db.exec('alter table public.mega_audit_records enable trigger mega_audit_operation_guard');
  await q('insert into public.mega_product_queries(id,workspace_id,created_by,encrypted_query) values($1,$2,$3,$4)',[R,W,U,cipher]);
  await q('insert into public.mega_product_prices(workspace_id,product_tag,encrypted_price,version,updated_by) values($1,$2,$3,2,$4)',[W,'c'.repeat(64),cipher,A]);
  const OTHER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await q('insert into public.mega_audit_workspace(id) values($1)',[OTHER]);await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin')",[OTHER,X]);
  await q('insert into storage.objects(bucket_id,name,owner) values($1,$2,$3)',['mega-audit-documents',`${OTHER}/${X}/${R}/pdf.bin`,X]);
  await t.test('ordinary member, outsider, anonymous and forged role cannot export keys',async()=>{
   for(const id of [U,X])await as(id,()=>assert.rejects(snapshot,e=>e.code==='42501'));
   await as(null,()=>assert.rejects(snapshot,e=>e.code==='42501'),'anon');
   await q("select set_config('request.jwt.claim.role','admin',false)");await as(U,()=>assert.rejects(snapshot,e=>e.code==='42501'));
  });
  const original=await as(A,snapshot);
  await t.test('all approved data, wrapped keys and documents are present; no passwords/tokens or foreign workspace',async()=>{
   assert.equal(original.tables.mega_audit_records.length,1);assert.equal(original.tables.mega_audit_user_keys.length,2);assert.equal(original.tables.mega_product_prices[0].version,2);assert.equal(original.tables.mega_product_queries.length,1);assert.equal(original.objects.length,2);
   assert.deepEqual(original.authors.map(a=>a.user_id),[A,U]);assert.ok(!JSON.stringify(original).includes(OTHER));assert.ok(!JSON.stringify(original).includes('email_confirmed_at'));
   await db.exec(fs.readFileSync(path.join(ROOT,'supabase/respaldos.sql'),'utf8'));assert.deepEqual((await as(A,snapshot)).tables,original.tables);
  });
  await t.test('restore inserts missing rows with original identity/time, preserves newer prices and permissions, can repeat safely',async()=>{
   const generated=spawnSync('python3',['-c',"import importlib.util,sys,json;s=importlib.util.spec_from_file_location('restore','tools/restore-megacontrol.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.restore_sql(json.load(sys.stdin)))"],{cwd:ROOT,input:JSON.stringify(original),encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
   await q('delete from public.mega_product_queries');await q('delete from public.mega_audit_records');
   await q("update public.mega_product_prices set version=3,encrypted_price=$1",[Buffer.from('Precio posterior al respaldo').toString('base64')]);await q("update public.mega_audit_members set role='user' where user_id=$1",[A]);
   await q("select set_config('request.jwt.claim.sub','',false)");await db.exec(generated.stdout);await db.exec(generated.stdout);
   assert.deepEqual((await q('select to_jsonb(r) as data from public.mega_audit_records r')).map(r=>r.data),original.tables.mega_audit_records);
   assert.deepEqual((await q('select to_jsonb(q) as data from public.mega_product_queries q')).map(r=>r.data),original.tables.mega_product_queries);
   assert.equal((await q('select version from public.mega_product_prices'))[0].version,3);assert.equal((await q('select role from public.mega_audit_members where user_id=$1',[A]))[0].role,'user');
   assert.equal((await q("select count(*)::int n from pg_trigger where tgrelid='public.mega_audit_records'::regclass and tgname in ('mega_audit_record_stamp','mega_audit_operation_guard') and tgenabled='O'"))[0].n,2);
   const mismatch=structuredClone(original);mismatch.tables.mega_audit_workspace[0].key_fingerprint='d'.repeat(64);
   const bad=spawnSync('python3',['-c',"import importlib.util,sys,json;s=importlib.util.spec_from_file_location('restore','tools/restore-megacontrol.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.restore_sql(json.load(sys.stdin)))"],{cwd:ROOT,input:JSON.stringify(mismatch),encoding:'utf8'});
   await assert.rejects(db.exec(bad.stdout),/no coincide/);await db.exec('rollback');
   assert.equal((await q('select count(*)::int n from public.mega_audit_records'))[0].n,1);
  });
  await t.test('revoked administrator cannot export any more data',async()=>{
    await as(A,()=>assert.rejects(snapshot,e=>e.code==='42501'));await q('delete from public.mega_audit_user_keys where user_id=$1',[A]);await q('delete from public.mega_audit_members where user_id=$1',[A]);await as(A,()=>assert.rejects(snapshot,e=>e.code==='42501'));
  });
 }finally{await db.close();}
});
