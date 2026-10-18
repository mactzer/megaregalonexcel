#!/usr/bin/env python3
"""Publish the already signed distribution APK after native CI passes. Never handles a signing key."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
REPOSITORY = 'mactzer/megaregalonexcel'
CERTIFICATE = '2127e11735ed9d5b2c472c36ab687d871c891795755b55e339af7a3d4ab2220b'


def request(path, value=None, method='GET', content_type='application/json'):
    url = path if path.startswith('https://') else 'https://api.github.com/repos/' + REPOSITORY + path
    body = json.dumps(value).encode() if isinstance(value, dict) else value
    headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
               'Accept': 'application/vnd.github+json', 'Content-Type': content_type,
               'X-GitHub-Api-Version': '2022-11-28'}
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=120) as response:
        return None if response.status == 204 else json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    source = (ROOT / 'build-apk.py').read_text()
    version = re.search(r"^VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'", source, re.M).group(1)
    code = re.search(r'^VERSION_CODE = ([0-9]+)', source, re.M).group(1)
    apk = ROOT / 'distribution' / ('MegaControl-' + version + '.apk')
    checksum = apk.with_suffix('.apk.sha256')
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    assert checksum.read_text().strip() == digest + '  ' + apk.name, 'Checksum de distribución incorrecto'
    with zipfile.ZipFile(apk) as archive:
        assert not any(n.endswith(('.html', '.htm', '.js')) for n in archive.namelist())
        for name in archive.namelist():
            if name.endswith('.dex'):
                assert b'Landroid/webkit/WebView;' not in archive.read(name), 'WebView inesperado'
    if args.verify:
        sdk = Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT']) / 'build-tools' / '35.0.0'
        signature = subprocess.check_output([sdk / 'apksigner', 'verify', '--print-certs', apk], text=True)
        assert 'certificate SHA-256 digest: ' + CERTIFICATE in signature, 'Firma de publicación inesperada'
        manifest = subprocess.check_output([sdk / 'aapt2', 'dump', 'badging', apk], text=True)
        assert "name='io.github.mactzer.megacontrol'" in manifest
        assert "versionCode='" + code + "'" in manifest
        assert "versionName='" + version + "'" in manifest
    print('Distribución nativa comprobada:', apk.name, digest, flush=True)
    if not args.publish:
        return
    tag = 'android-v' + version
    release = next((r for r in request('/releases?per_page=100') if r['tag_name'] == tag), None)
    notes = (ROOT / 'RELEASE_NOTES.md').read_text()
    metadata = {'tag_name': tag, 'target_commitish': os.environ['GITHUB_SHA'],
                'name': 'MegaControl Android nativo ' + version, 'body': notes, 'prerelease': False}
    if release is None:
        release = request('/releases', dict(metadata, draft=True), 'POST')
    for file, mime in [(apk, 'application/vnd.android.package-archive'), (checksum, 'text/plain')]:
        wanted = 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
        previous = next((a for a in release['assets'] if a['name'] == file.name), None)
        if previous and previous.get('digest') == wanted:
            continue
        if previous:
            assert release['draft'], 'Aumenta la versión antes de sustituir un APK ya publicado'
            request('/releases/assets/' + str(previous['id']), method='DELETE')
        url = release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(file.name)
        asset = request(url, file.read_bytes(), 'POST', mime)
        assert asset['digest'] == wanted, 'GitHub no confirmó el hash publicado'
    published = request('/releases/' + str(release['id']), dict(metadata, draft=False), 'PATCH')
    print('APK publicado:', published['html_url'])


if __name__ == '__main__':
    main()
