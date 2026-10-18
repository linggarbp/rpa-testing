/**
 * Word documents, the stdlib way: a .docx is a zip whose text lives in `word/document.xml`. The zip
 * reader/writer already exist for packages (src/pack.ts) — this module only adds the XML half:
 * paragraphs out (runs, tabs, breaks, entities decoded) and a minimal valid docx in.
 */
import { readFile } from 'node:fs/promises';
import { readArchive, writeArchive } from './pack.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? match;
  });
}

export function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The text of a document.xml: one line per paragraph, `<w:tab/>` as a tab, `<w:br/>` as a break. */
export function documentText(xml: string): string {
  const paragraphs: string[] = [];
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = paragraph[1] ?? '';
    let text = '';
    for (const token of inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
      if (token[1] !== undefined) text += decodeXml(token[1]);
      else if (token[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    paragraphs.push(text);
  }
  if (paragraphs.length === 0) {
    // No paragraph marks at all (a fragment): fall back to the raw text runs.
    for (const run of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) paragraphs.push(decodeXml(run[1] ?? ''));
  }
  return paragraphs.join('\n');
}

export async function readDocx(file: string): Promise<string> {
  let entries: Map<string, Buffer>;
  try {
    entries = readArchive(await readFile(file));
  } catch (e) {
    throw new Error(`${file}: not a readable .docx (${(e as Error).message})`);
  }
  const document = entries.get('word/document.xml');
  if (!document) throw new Error(`${file} has no word/document.xml — not a .docx file.`);
  return documentText(document.toString('utf8'));
}

/** A minimal, valid .docx: the three parts Word (and LibreOffice) insist on, nothing more. */
export function buildDocx(text: string): Buffer {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${encodeXml(line)}</w:t></w:r></w:p>`)
    .join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  return writeArchive(new Map([
    ['[Content_Types].xml', Buffer.from(contentTypes)],
    ['_rels/.rels', Buffer.from(rels)],
    ['word/document.xml', Buffer.from(document)]
  ]));
}
