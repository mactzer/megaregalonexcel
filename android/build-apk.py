#!/usr/bin/env python3
"""Build with official Android SDK/JDK tools and checksum-pinned dependencies, without Gradle.

SDK platform android-35 and build-tools 35.0.0 are required. Keep the signing
keystore outside the checkout. Its password is read from the named environment
variable and is never printed or stored in build outputs.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile
import json
import re
import urllib.request

ROOT = Path(__file__).resolve().parent
VERSION = '1.1.0'
VERSION_CODE = 2

def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)

def build(args, manifest, source, resources, assets, out_name, extra_classpath=None):
    out = ROOT / 'build' / out_name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    res = out / 'res'
    shutil.copytree(resources, res)
    if out_name == 'app':
        (res / 'drawable-nodpi').mkdir(exist_ok=True)
        shutil.copyfile(ROOT.parent / 'megacontrol-logo.png',res / 'drawable-nodpi' / 'megacontrol_logo.png')
    sdk = Path(args.sdk)
    bt = Path(args.build_tools) if args.build_tools else sdk / 'build-tools' / '35.0.0'
    platform = Path(args.platform) if args.platform else sdk / 'platforms' / 'android-35' / 'android.jar'
    for f in [bt / 'aapt2',bt / 'lib' / 'd8.jar',bt / 'zipalign',bt / 'apksigner',platform]:
        if not f.is_file():
            raise SystemExit('Falta una herramienta oficial del SDK: ' + str(f))
    gen, classes = out / 'generated', out / 'classes'
    gen.mkdir(); classes.mkdir()
    if out_name == 'app':
        config=(ROOT.parent / 'supabase-config.js').read_text()
        values={key:re.search(r'\b'+key+r':\s*"([^"]+)"',config).group(1) for key in ['url','publishableKey','workspaceId']}
        destination=gen / 'io/github/mactzer/megacontrol/BuildConfig.java';destination.parent.mkdir(parents=True,exist_ok=True)
        constants={'VERSION_NAME':VERSION,'SUPABASE_URL':values['url'],'PUBLIC_KEY':values['publishableKey'],'WORKSPACE':values['workspaceId']}
        destination.write_text('package io.github.mactzer.megacontrol;\nfinal class BuildConfig {\n'+''.join('static final String '+k+' = '+json.dumps(v)+';\n' for k,v in constants.items())+'static final int VERSION_CODE = '+str(VERSION_CODE)+';\n}\n')
    dependencies=[]
    for dependency in json.loads((ROOT / 'dependencies.json').read_text()):
        f=ROOT / 'build' / 'dependencies' / dependency['name'];f.parent.mkdir(parents=True,exist_ok=True)
        if not f.exists():
            with urllib.request.urlopen(dependency['url'],timeout=60) as response:f.write_bytes(response.read())
        if hashlib.sha256(f.read_bytes()).hexdigest()!=dependency['sha256']:
            raise SystemExit('No coincide el checksum de '+f.name)
        dependencies.append(f)
    compiled, unsigned = out / 'resources.zip', out / 'unsigned.apk'
    run([bt / 'aapt2','compile','--dir',res,'-o',compiled])
    link=[bt / 'aapt2','link','-o',unsigned,'--manifest',manifest,'-I',platform,
          '--java',gen,'--min-sdk-version','26','--target-sdk-version','35',
          '--version-code',str(VERSION_CODE),'--version-name',VERSION,compiled]
    if assets:
        link += ['-A',assets]
    run(link)
    files = sorted(source.rglob('*.java')) + sorted(gen.rglob('*.java'))
    if out_name == 'test':
        files += [ROOT / 'tests' / 'NativeContract.java']
    bootclasspath = os.pathsep.join([str(bt / 'core-lambda-stubs.jar'), str(platform)])
    compiler = [args.java,'com.sun.tools.javac.Main','-encoding','UTF-8','-source','8','-target','8','-Xlint:-options',
                '-bootclasspath',bootclasspath,'-d',classes]
    classpath=dependencies+([extra_classpath] if extra_classpath else [])
    if classpath:
        compiler += ['-classpath',os.pathsep.join(str(p) for p in classpath)]
    run(compiler+files)
    jar = out / 'classes.jar'
    with zipfile.ZipFile(jar,'w',compression=zipfile.ZIP_DEFLATED) as z:
        for f in sorted(classes.rglob('*.class')):
            z.write(f,f.relative_to(classes).as_posix())
    dex = out / 'dex'; dex.mkdir()
    d8=[args.java,'-cp',bt / 'lib' / 'd8.jar','com.android.tools.r8.D8','--release','--min-api','26','--lib',platform,'--output',dex]
    if extra_classpath:
        d8 += ['--classpath',extra_classpath]
    if out_name == 'test':
        for dependency in dependencies:
            d8 += ['--classpath',dependency]
    run(d8+[jar]+(dependencies if out_name=='app' else []))
    with zipfile.ZipFile(unsigned,'a',compression=zipfile.ZIP_DEFLATED) as z:
        for f in sorted(dex.glob('*.dex')):
            z.write(f,f.name)
    aligned=out / 'aligned.apk'
    run([bt / 'zipalign','-P','16','-f','4',unsigned,aligned])
    signed=ROOT / 'build' / ('MegaControl-'+VERSION+('.test' if out_name=='test' else '')+'.apk')
    run([bt / 'apksigner','sign','--ks',args.keystore,'--ks-key-alias',args.alias,
         '--ks-pass','env:'+args.password_env,'--key-pass','env:'+args.password_env,'--out',signed,aligned])
    run([bt / 'apksigner','verify','--verbose','--print-certs',signed])
    run([bt / 'zipalign','-c','-P','16','4',signed])
    digest=hashlib.sha256(signed.read_bytes()).hexdigest()
    signed.with_suffix('.apk.sha256').write_text(digest+'  '+signed.name+'\n')
    print(str(signed),signed.stat().st_size,'bytes; SHA-256',digest,flush=True)
    return classes

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sdk',default=os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME') or '')
    p.add_argument('--build-tools'); p.add_argument('--platform'); p.add_argument('--java',default='java')
    p.add_argument('--keystore',required=True); p.add_argument('--alias',default='megacontrol')
    p.add_argument('--password-env',default='MEGACONTROL_ANDROID_STORE_PASSWORD')
    p.add_argument('--with-tests',action='store_true')
    args=p.parse_args()
    if not Path(args.keystore).is_file() or not os.environ.get(args.password_env):
        raise SystemExit('Falta el almacén de firma o su variable de contraseña. No se generan claves nuevas automáticamente.')
    classes=build(args,ROOT/'AndroidManifest.xml',ROOT/'src',ROOT/'res',None,'app')
    if args.with_tests:
        build(args,ROOT/'tests'/'AndroidManifest.xml',ROOT/'tests'/'src',ROOT/'tests'/'res',ROOT/'build'/'native-fixture','test',classes)

if __name__=='__main__':
    main()
