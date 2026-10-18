'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const C=require('../../audit-crypto.js');
(async()=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'megacontrol-native-contract-'));
 const workspace='86551e44-7504-4d30-b453-c9e04b269a43',password='Frase ficticia segura ñ 📦 2026';
 const recovery='MEGA1.'+Buffer.alloc(32,42).toString('base64url');
 const account=await C.unlockUser('ficticio',password,workspace),team=await C.unlock(recovery,workspace);
 const seal=async(value,aad)=>Buffer.from(await team.encrypt(new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)),aad)).toString('base64');
 const metadataPlain=JSON.stringify({codigo:'0012345678905',costo:0,pventa:7.99,salidas_unidades:12});
 const docs=[{id:'22222222-2222-4222-8222-222222222222',date:'2026-10-18T20:00:00Z',invoiceDate:'2026-10-08',salida:'29317',price:9.99},{id:'33333333-3333-4333-8333-333333333333',date:'2026-10-10T20:00:00Z',invoiceDate:'2026-10-09',salida:'29345',price:8.99}];
 const sources=[],shared=[];for(let i=0;i<docs.length;i++){const d=docs[i],revision=String(i+1).repeat(32);sources.push({id:d.id,created_at:d.date,metadata_revision:revision,encrypted_metadata:'unused-fictional'});shared.push({record_id:d.id,metadata_revision:revision,encrypted_catalog:await seal({products:[{codigo:'0012345678905',descripcion:'PRODUCTO FICTICIO',ref:'REF-01',empaque:'pza',pventa:d.price}],salida:d.salida,invoiceDate:d.invoiceDate,kind:'salida',date:d.date},'shared-catalog-v1|'+d.id+'|'+revision)});}
 const pdf=Buffer.from('%PDF-1.4\nDocumento FICTICIO para contrato nativo 00123\n');
 const fixture={workspace,password,authPassword:account.authPassword,wrapped:Buffer.from(await account.wrapRecoveryKey(recovery)).toString('base64'),fingerprint:team.fingerprint,productTag:await team.productIndex('0012345678905'),metadataPlain,metadataCipher:await seal(metadataPlain,'record-fictional|metadata'),sources,shared,pdfPlain:pdf.toString('base64'),pdfCipher:Buffer.from(await team.encrypt(pdf,docs[0].id+'|pdf')).toString('base64')};
 fs.writeFileSync(path.join(output,'fixture.json'),JSON.stringify(fixture));
 fs.mkdirSync(path.join(__dirname,'../build/native-fixture'),{recursive:true});
 fs.writeFileSync(path.join(__dirname,'../build/native-fixture/fixture.json'),JSON.stringify(fixture));
 const jsonJar=process.env.ANDROID_JSON_TEST_JAR||'/workspace/android-tools-cache/native-libs/json-tests.jar';
 if(!fs.existsSync(jsonJar))throw new Error('Falta org.json (solo para ejecutar contratos en la JVM).');
 const src=path.join(__dirname,'../src/io/github/mactzer/megacontrol'),generated=path.join(output,'BuildConfig.java');
 fs.writeFileSync(generated,'package io.github.mactzer.megacontrol; final class BuildConfig {static final String SUPABASE_URL="https://fixture.invalid", PUBLIC_KEY="fictional-public", WORKSPACE="'+workspace+'";}');
 function run(args){const r=spawnSync('java',args,{encoding:'utf8'});if(r.status!==0)throw new Error(r.stdout+'\n'+r.stderr);process.stdout.write(r.stdout);}
 run(['com.sun.tools.javac.Main','-encoding','UTF-8','-cp',jsonJar,'-d',output,generated,path.join(src,'Crypto.java'),path.join(src,'NativeApi.java'),path.join(__dirname,'NativeContract.java')]);
 run(['-cp',output+path.delimiter+jsonJar,'io.github.mactzer.megacontrol.NativeContract',path.join(output,'fixture.json'),path.join(output,'result.json')]);
 const result=JSON.parse(fs.readFileSync(path.join(output,'result.json')));assert.equal(new TextDecoder().decode(await team.decrypt(Buffer.from(result.javaCipher,'base64'),'interop-native')),'Prueba nativa con ceros 00123, precio 7.99 y emoji 📦');
 console.log('AES-GCM Java -> web confirmado. Sin conexión a la base real.');
 fs.rmSync(output,{recursive:true,force:true});
})().catch(error=>{console.error(error);process.exitCode=1;});
