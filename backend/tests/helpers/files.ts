export const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
export const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml....")]);

export function textFile(content: string) {
  return Buffer.from(content);
}

export function form(files: { name: string; type: string; data: Buffer }[]): FormData {
  const f = new FormData();
  for (const file of files) f.append("files", new File([new Uint8Array(file.data)], file.name, { type: file.type }));
  return f;
}
