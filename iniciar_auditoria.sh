#!/usr/bin/env bash
set -euo pipefail

AUDITORIA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$AUDITORIA_ROOT/intranet/server.py" ]]; then
    printf '%s\n' 'No se encuentra intranet/server.py. Extrae el ZIP completo y conserva sus carpetas.' >&2
    exit 1
fi

AUDITORIA_PYTHON=''
for AUDITORIA_CANDIDATO in python3 python; do
    if command -v "$AUDITORIA_CANDIDATO" >/dev/null 2>&1 && "$AUDITORIA_CANDIDATO" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
        AUDITORIA_PYTHON="$AUDITORIA_CANDIDATO"
        break
    fi
done

if [[ -z "$AUDITORIA_PYTHON" ]]; then
    printf '%s\n' 'Se necesita Python 3.10 o posterior. Instálalo y vuelve a ejecutar este archivo.' >&2
    exit 1
fi

printf '%s\n' 'Dirección predeterminada: http://127.0.0.1:8080/' 'Conserva esta terminal abierta mientras tus compañeros usan la aplicación.'
exec "$AUDITORIA_PYTHON" "$AUDITORIA_ROOT/intranet/server.py" --host 0.0.0.0 --port 8080 "$@"
