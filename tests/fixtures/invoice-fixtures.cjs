'use strict';
// Fictional original PDFs. No customer documents or real transaction data.
function pdf(format='nevada'){
 const W=1000,H=1400,body=[];
 const text=(s,x,y,size=16)=>body.push(`BT /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[()\\]/g,'\\$&')}) Tj ET`);
 const row=(s,x,y)=>text(s,x,y,16);
 const codes=['1234509876543','1234509876550'];
 text((format==='nevada'?'NEVADA OUTLET':format==='feduro'?'FEDURO':'SKECHERS')+' - DOCUMENTO FICTICIO',80,1330,22);
 text('Factura de prueba SIN VALOR COMERCIAL',80,1290);
 if(format==='nevada'){text('PEDIDO No. 55001',650,1250);text('Fecha de Emision',80,1220);text('12/10/2026',80,1190);
  for(const [s,x]of [['CB',110],['Producto',180],['Descripcion',310],['Bulto',580],['Cant.',635],['U/Vta',680],['Precio',730],['DESC',795],['Subtotal',860]])text(s,x,1100);
  for(let i=0;i<2;i++){const y=1040-i*100;row(codes[i],130,y);row('PRF-FICTICIO PERFUME '+(i+1),290,y);row('1.00',580,y);row('12',635,y);row('pza',680,y);row('3.00',735,y);row('36.00',865,y);}
 }else if(format==='feduro'){text('Numero: 55002',70,1260);text('Fecha de Emision: 12-10-2026',70,1220);
  for(const [s,x]of [['No.',50],['Descripcion',100],['Cantidad',450],['U/M',525],['Precio',575],['Descuento',640],['Monto',705],['ITBMS',780],['Valor Item',840]])text(s,x,1100);
  for(let i=0;i<2;i++){const y=1030-i*160;row(String(i+1).padStart(3,'0'),50,y);row('- HB-025486'+i+' - PRODUCTO FICTICIO',90,y);row('6.0000',465,y);row('und',535,y);row('10.0000',575,y);row('0.0000',640,y);row('60.0000',705,y);row('4.2000',780,y);row('64.2000',855,y);row('('+codes[i]+') (0 CJ) (6.000 UN)',100,y-28);}
 }else{text('N. Documento Fiscal 55003',70,1220);text('Fecha emision 12/10/2026',70,1180);
  for(let i=0;i<2;i++){const y=600-i*190;for(const [s,x]of [['Codigo Item',75],['Cantidad',230],['Descripcion',310],['Descuento',640],['Precio unitario',720],['Importe',810]])text(s,x,y+45);row('117775N/TOL'+i,80,y);row('12',250,y);row('BOBS FICTICIO ZAPATO '+i,305,y);row('0.00',645,y);row('35.00',730,y);row('420.00',820,y);row('ITBMS 7%',80,y-60);}
 }
 const stream=body.join('\n'),objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let output='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`;});const start=Buffer.byteLength(output);output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return Buffer.from(output);
}
function raster(jpeg,width,height){
 const content=Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`),objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]),Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream')])];
 let chunks=[Buffer.from('%PDF-1.4\n')],length=chunks[0].length,offsets=[];objects.forEach((o,i)=>{offsets.push(length);const b=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),o,Buffer.from('\nendobj\n')]);chunks.push(b);length+=b.length;});chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));return Buffer.concat(chunks);
}
module.exports={pdf,raster};
