(function (root) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  function inspect(rows, info, totals, imported = false) {
    const affected = [], comparisons = [], missingIdentifiers = [];
    rows.forEach((row, index) => {
      const fields = [];
      if (!String(row.codigo || '').trim() && !String(row.ref || '').trim()) {
        fields.push('Código de barras o referencia');
        missingIdentifiers.push(index + 1);
      }
      if (!finite(row.salidas_unidades)) fields.push('Cantidad');
      if (!finite(row.costo)) fields.push('Costo');
      if (!imported && !finite(row.salidas_total)) fields.push('Importe');
      if (!imported && totals.invalidTaxRows && totals.invalidTaxRows.includes(index)) fields.push('I.V.');
      if (fields.length) affected.push({ index: index + 1, code: String(row.codigo || row.ref || ''), description: row.descripcion || '', fields });
    });
    for (const [label, printed, calculated] of [
      ['Unidades', info.total_unidades, totals.totalUnidades],
      ['Subtotal', info.subtotal, totals.subtotal],
      ['Impuesto', info.impuesto, totals.impuesto],
      ['Total neto', info.total_neto, totals.totalNeto]
    ]) {
      const available = finite(printed) && finite(calculated);
      const difference = available ? round(calculated - printed) : null;
      comparisons.push({ label, printed: finite(printed) ? printed : null, calculated: finite(calculated) ? calculated : null, difference, state: !available ? 'unavailable' : Math.abs(difference) <= 0.01 ? 'ok' : 'mismatch' });
    }
    const needsReview = affected.length > 0 || comparisons.some(row => row.state === 'mismatch') || (!imported && !finite(totals.impuesto));
    return { affected, comparisons, missingIdentifiers, needsReview, complete: !needsReview };
  }
  const api = Object.freeze({ inspect });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DocumentValidation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
