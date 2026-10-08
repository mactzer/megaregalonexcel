(function (root) {
  "use strict";

  const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const TABLE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";

  function xmlAttribute(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    }[char])).replace(/[\t\n\r]/g, char => `&#${char.charCodeAt(0)};`);
  }

  function write(XLSX, workbook, options) {
    const sheetIndex = workbook.SheetNames.indexOf(options.sheetName);
    const sheet = workbook.Sheets[options.sheetName];
    const headers = options.headers;
    if (sheetIndex < 0 || !sheet || !sheet["!ref"] || !headers.length) {
      throw new Error("No se encontraron los datos para crear la tabla del Excel.");
    }
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    // El resumen ocupa también B cuando solo se selecciona una columna.
    // La tabla conserva exactamente las columnas seleccionadas por el usuario.
    const tableRef = `A1:${XLSX.utils.encode_col(headers.length - 1)}${range.e.r + 1}`;
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    const archive = XLSX.CFB.read(bytes, { type: "array" });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const read = path => {
      const entry = XLSX.CFB.find(archive, path);
      return entry ? decoder.decode(entry.content) : null;
    };
    const put = (path, xml) => XLSX.CFB.utils.cfb_add(archive, path, encoder.encode(xml));
    const sheetPath = `/xl/worksheets/sheet${sheetIndex + 1}.xml`;
    const relsPath = `/xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`;
    let sheetXml = read(sheetPath);
    let relsXml = read(relsPath) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"></Relationships>`;
    let typesXml = read("/[Content_Types].xml");
    if (!sheetXml || !typesXml) throw new Error("No se pudo preparar la tabla del Excel.");
    const usedIds = new Set([...relsXml.matchAll(/\bId="([^"]+)"/g)].map(match => match[1]));
    let relationshipId = "rIdDatosTable";
    for (let i = 2; usedIds.has(relationshipId); i++) relationshipId = `rIdDatosTable${i}`;

    const tableXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<table xmlns="${MAIN_NS}" id="1" name="DatosTabla" displayName="DatosTabla" ref="${tableRef}" headerRowCount="1" totalsRowShown="0">` +
      `<autoFilter ref="${tableRef}"/>` +
      `<tableColumns count="${headers.length}">` +
      headers.map((header, index) => `<tableColumn id="${index + 1}" name="${xmlAttribute(header)}"/>`).join("") +
      `</tableColumns><tableStyleInfo name="TableStyleLight1" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
    const tableParts = `<tableParts count="1"><tablePart r:id="${relationshipId}"/></tableParts>`;
    // tableParts debe aparecer antes de extLst, si la hoja tiene extensiones.
    sheetXml = sheetXml.includes("<extLst")
      ? sheetXml.replace("<extLst", tableParts + "<extLst")
      : sheetXml.replace("</worksheet>", tableParts + "</worksheet>");
    relsXml = relsXml.replace("</Relationships>", `<Relationship Id="${relationshipId}" Type="${TABLE_REL}" Target="../tables/table1.xml"/></Relationships>`);
    typesXml = typesXml.replace("</Types>", `<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`);
    put("/xl/tables/table1.xml", tableXml);
    put(sheetPath, sheetXml);
    put(relsPath, relsXml);
    put("/[Content_Types].xml", typesXml);
    return XLSX.CFB.write(archive, { type: "array", fileType: "zip", compression: true });
  }

  const api = { write };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ExcelTable = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
