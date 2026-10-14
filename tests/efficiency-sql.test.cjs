'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const W='86551e44-7504-4d30-b453-c9e04b269a43',A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',X='44444444-4444-4444-8444-444444444444',ID='99999999-9999-4999-8999-000000000001',TAG='a'.repeat(64),cipher=Buffer.from('Fictional encrypted payload for efficiency tests').toString('base64');
test('price history and shared catalog enforce permissions, preserve records and survive retries, migration and backup',async t=>{
 const db=new PGlite(),q=async(s,p=[]) =>(await db.query(s,p)).rows,scalar=async(s,p=[])=>Object.values((await q(s,p))[0])[0],sql=name=>fs.readFileSync(path.join(__dirname,'../supabase',name+'.sql'),'utf8');
 async function as(user,work,role='authenticated'){await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec('set role '+role);try{return await work();}finally{await db.exec('reset role');}}
 const set=(value,version)=>scalar('select public.mega_product_price_set($1,$2,$3,$4)',[W,TAG,value,version]);
 const put=revision=>scalar('select public.mega_product_catalog_put($1,$2,$3,$4)',[W,ID,revision,cipher]);
 try{
  await db.exec(fs.readFileSync(path.join(__dirname,'supabase-sql.test.cjs'),'utf8').match(/const bootstrap = `([\s\S]*?)`;/)[1]);await db.exec('alter table storage.objects add column updated_at timestamptz default now()');
  for(const name of ['auditoria','precios','consultas-operaciones','importaciones','versiones-salidas','salidas-automaticas'])await db.exec(sql(name));
  for(const [id,name]of [[A,'admin'],[U,'worker'],[X,'outsider']])await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,name+'@usuarios.megaregalonexcel.invalid']);
  await q("insert into public.mega_audit_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'user')",[W,A,U]);await as(A,()=>set(cipher,0));
  await q('update public.mega_audit_workspace set key_fingerprint=$1 where id=$2',[TAG,W]);await db.exec(sql('eficiencia'));await db.exec(sql('eficiencia'));
  await t.test('existing price is preserved, each update is retained and an identical retry is idempotent',async()=>{
    assert.equal((await q('select count(*)::int n from public.mega_product_price_history'))[0].n,1);
    const next=Buffer.from('New fictional encrypted payload for changed price').toString('base64');const row=await as(A,()=>set(next,1));assert.equal(row.version,2);assert.deepEqual(await as(A,()=>set(next,1)),row);
    assert.equal((await q('select count(*)::int n from public.mega_product_price_history'))[0].n,2);await as(A,()=>assert.rejects(set(cipher,1),e=>e.code==='40001'));
    await as(U,()=>assert.rejects(set(cipher,2),e=>e.code==='42501'));assert.equal((await as(U,()=>q('select * from public.mega_product_price_history'))).length,2);assert.equal((await as(X,()=>q('select * from public.mega_product_price_history'))).length,0);
  });
  await as(A,async()=>{
    await scalar('select public.mega_salida_prepare($1,$2,$2,$2,$3)',[W,TAG,ID]);for(const kind of ['pdf','excel'])await q('insert into storage.objects(bucket_id,name,owner) values($1,$2,$3)',['mega-audit-documents',`${W}/${A}/${ID}/${kind}.bin`,A]);
    await scalar('select public.mega_salida_commit($1,$2,$2,$2,$3,$2,$4)',[W,TAG,ID,cipher]);
  });
  const revision=await scalar('select md5(encrypted_metadata) from public.mega_audit_records where id=$1',[ID]);
  await t.test('shared index is revision-bound, read by members and cannot be replaced by stale or unauthorized data',async()=>{
    assert.equal(await as(A,()=>put(revision)),true);assert.equal(await as(A,()=>put(revision)),true);assert.equal((await q('select count(*)::int n from public.mega_product_catalog'))[0].n,1);
    await as(A,()=>assert.rejects(put('b'.repeat(32)),e=>e.code==='40001'));await as(U,()=>assert.rejects(put(revision),e=>e.code==='42501'));await as(X,()=>assert.rejects(put(revision),e=>e.code==='42501'));
    assert.equal((await as(U,()=>q('select * from public.mega_product_catalog'))).length,1);assert.equal((await as(X,()=>q('select * from public.mega_product_catalog'))).length,0);
    assert.equal((await q('select count(*)::int n from storage.objects'))[0].n,2);
  });
  await t.test('backup includes price history, remains admin-only and repeatable migration preserves every entry',async()=>{
    const backup=await as(A,()=>scalar('select public.mega_audit_backup_snapshot($1)',[W]));assert.equal(backup.tables.mega_product_price_history.length,2);assert.equal(backup.tables.mega_audit_records.length,1);assert.equal(backup.objects.length,2);
    await as(U,()=>assert.rejects(scalar('select public.mega_audit_backup_snapshot($1)',[W]),e=>e.code==='42501'));await db.exec(sql('eficiencia'));assert.equal((await q('select count(*)::int n from public.mega_product_price_history'))[0].n,2);
  });
  await t.test('restrictive policies block direct changes after accidental broad grants; revoked admin cannot retry',async()=>{
    for(const table of ['mega_product_price_history','mega_product_catalog']){
      await db.exec('grant select,insert,update,delete on public.'+table+' to authenticated,anon; create policy overly_broad on public.'+table+' for all to authenticated,anon using(true) with check(true)');
      assert.deepEqual(await as(A,()=>q('delete from public.'+table+' returning *')),[]);assert.deepEqual(await as(X,()=>q('select * from public.'+table)),[]);assert.deepEqual(await as(null,()=>q('select * from public.'+table),'anon'),[]);
    }
    await q("update public.mega_audit_members set role='user' where user_id=$1",[A]);await as(A,()=>assert.rejects(set(cipher,2),e=>e.code==='42501'));
  });
 }finally{await db.close();}
});
