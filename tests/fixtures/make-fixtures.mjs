// Generates small sample documents for the automated tests (and for trying the app).
// Usage: node tests/fixtures/make-fixtures.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';

const out = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'out'));
fs.mkdirSync(out, { recursive: true });

const TOPICS = [
  ['Place value', 'Place value tells us the value of each digit in a number. In 384, the digit 3 is worth 300, the 8 is worth 80 and the 4 is worth 4.'],
  ['Long multiplication', 'To multiply 384 by 27, first multiply 384 by 7 to get 2688. Then multiply 384 by 20 to get 7680. Finally add 2688 and 7680 to get 10368.'],
  ['Short division', 'To divide 852 by 4, divide each digit from the left. 8 divided by 4 is 2, 5 divided by 4 is 1 remainder 1, and 12 divided by 4 is 3, so the answer is 213.'],
  ['Equivalent fractions', 'Equivalent fractions have the same value. One half is equivalent to two quarters because 1/2 = 2/4. Multiply the numerator and denominator by the same number.'],
  ['Decimals', 'A decimal point separates whole numbers from parts of a whole. In 3.75 the 7 is worth seven tenths and the 5 is worth five hundredths.'],
  ['Percentages', 'Per cent means out of one hundred. To find 25% of 80, find one quarter of 80, which is 20.'],
];

async function makePdf() {
  // 8 PDF pages: page 1 is a cover (no number), page 2 is "contents", printed numbering starts at PDF page 3 = "1".
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cover = doc.addPage([420, 595]);
  cover.drawText('Sample Maths Book 6', { x: 60, y: 400, size: 24, font });
  cover.drawText('Pupil Book - Test Edition', { x: 60, y: 360, size: 14, font });
  const contents = doc.addPage([420, 595]);
  contents.drawText('Contents', { x: 60, y: 520, size: 18, font });
  TOPICS.forEach(([t], i) => contents.drawText(`${t} ........ ${i + 1}`, { x: 60, y: 480 - i * 22, size: 11, font }));
  TOPICS.forEach(([title, body], i) => {
    const p = doc.addPage([420, 595]);
    p.drawText(`Unit ${i + 1}: ${title}`, { x: 40, y: 540, size: 16, font });
    const words = body.split(' ');
    let line = '';
    let y = 500;
    for (const w of words) {
      if ((line + w).length > 60) {
        p.drawText(line, { x: 40, y, size: 11, font });
        y -= 16;
        line = '';
      }
      line += `${w} `;
    }
    p.drawText(line, { x: 40, y, size: 11, font });
    p.drawText(`Practice: answer the questions about ${title.toLowerCase()} in your exercise book.`, { x: 40, y: y - 30, size: 10, font });
    p.drawText(String(i + 1), { x: 205, y: 30, size: 10, font }); // printed page number in the footer
  });
  // A page with no text layer (simulates a scanned page): just a drawn rectangle.
  const scan = doc.addPage([420, 595]);
  scan.drawRectangle({ x: 40, y: 40, width: 340, height: 515, borderWidth: 2 });
  fs.writeFileSync(path.join(out, 'sample-maths-book.pdf'), await doc.save());
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>');
  const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  const body = [
    para('The Water Cycle', 'Heading1'),
    para('Evaporation', 'Heading2'),
    para('The Sun heats water in oceans, lakes and rivers. The water turns into water vapour and rises into the air. This process is called evaporation.'),
    para('Condensation', 'Heading2'),
    para('As water vapour rises it cools down and turns back into tiny droplets of liquid water, forming clouds. This is called condensation.'),
    para('Precipitation', 'Heading2'),
    para('When the droplets in clouds join together and become heavy, they fall as rain, snow, sleet or hail. This is called precipitation.'),
    para('Collection', 'Heading2'),
    para('Water collects in oceans, rivers, lakes and underground, and the cycle starts again.'),
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(path.join(out, 'water-cycle.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makePptx() {
  const zip = new JSZip();
  const slides = [
    ['Causes of World War One', ['Militarism: countries built up large armies and navies', 'Alliances: Europe split into the Triple Alliance and the Triple Entente']],
    ['The spark', ['Archduke Franz Ferdinand was assassinated in Sarajevo on 28 June 1914', 'Austria-Hungary declared war on Serbia on 28 July 1914']],
    ['Consequences', ['The Treaty of Versailles was signed in 1919', 'Germany had to accept blame and pay reparations']],
  ];
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach(([title, bullets], i) => {
    const sp = (text, ph) => `<p:sp><p:nvSpPr><p:cNvPr id="${i}" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${text.map((t) => `<a:p><a:r><a:t>${xmlEsc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${sp([title], 'title')}${sp(bullets)}</p:spTree></p:cSld></p:sld>`);
  });
  fs.writeFileSync(path.join(out, 'ww1-history.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makeEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const chapters = [
    ['Chapter 1: The Storm', 'The ship rocked as the storm grew stronger. Mara held the rope tightly and remembered her father’s promise.'],
    ['Chapter 2: The Island', 'In the morning Mara woke on a quiet beach. She was alone, but she found footprints leading into the forest.'],
  ];
  chapters.forEach(([t, b], i) => zip.file(`OEBPS/ch${i + 1}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1><p>${b}</p></body></html>`));
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="ch${i + 1}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Mara and the Island</dc:title><dc:creator>Test Author</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`);
  fs.writeFileSync(path.join(out, 'mara-island.epub'), await zip.generateAsync({ type: 'nodebuffer' }));
}

await Promise.all([makePdf(), makeDocx(), makePptx(), makeEpub()]);
fs.writeFileSync(path.join(out, 'notes.txt'), 'Photosynthesis is the process plants use to make food. Plants take in carbon dioxide and water and use energy from sunlight to make glucose and oxygen.\n\nChlorophyll is the green pigment in leaves that absorbs light energy.');
console.log(`Fixtures written to ${out}`);
