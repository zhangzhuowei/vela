/**
 * 零依赖 EPUB 生成器
 *
 * EPUB 本质是一个特定结构的 ZIP：
 *  - mimetype（必须为首个条目、且不压缩存储）
 *  - META-INF/container.xml
 *  - OEBPS/content.opf（包元数据 + manifest + spine）
 *  - OEBPS/nav.xhtml（EPUB3 导航）+ OEBPS/toc.ncx（EPUB2 兼容目录）
 *  - OEBPS/style.css
 *  - OEBPS/chapN.xhtml（各章正文）
 *
 * 这里用 Node 内置 zlib 做 deflate、自实现 CRC32 手写 ZIP，
 * 因此不引入任何第三方依赖。
 */
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

// ===== CRC32 =====
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ===== 极简 ZIP 写入器（支持 STORED 与 DEFLATE） =====
interface ZipEntry {
  nameBuf: Buffer
  method: number // 0=stored, 8=deflate
  crc: number
  compSize: number
  uncompSize: number
  offset: number
}

class ZipBuilder {
  private entries: ZipEntry[] = []
  private chunks: Buffer[] = []
  private offset = 0

  /** 添加一个条目；store=true 时强制不压缩（用于 mimetype） */
  add(name: string, content: Buffer, store = false): void {
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(content)

    let method = 0
    let data = content
    if (!store) {
      const deflated = zlib.deflateRawSync(content)
      if (deflated.length < content.length) {
        method = 8
        data = deflated
      }
    }

    const offset = this.offset
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4)         // version needed
    local.writeUInt16LE(0, 6)          // flags
    local.writeUInt16LE(method, 8)     // compression method
    local.writeUInt16LE(0, 10)         // mod time
    local.writeUInt16LE(0x21, 12)      // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)     // compressed size
    local.writeUInt32LE(content.length, 22)  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)         // extra length

    this.chunks.push(local, nameBuf, data)
    this.offset += 30 + nameBuf.length + data.length
    this.entries.push({ nameBuf, method, crc, compSize: data.length, uncompSize: content.length, offset })
  }

  /** 生成最终 ZIP Buffer */
  finish(): Buffer {
    const cdChunks: Buffer[] = []
    let cdSize = 0
    for (const e of this.entries) {
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)  // central dir header signature
      cd.writeUInt16LE(20, 4)          // version made by
      cd.writeUInt16LE(20, 6)          // version needed
      cd.writeUInt16LE(0, 8)           // flags
      cd.writeUInt16LE(e.method, 10)
      cd.writeUInt16LE(0, 12)          // mod time
      cd.writeUInt16LE(0x21, 14)       // mod date
      cd.writeUInt32LE(e.crc, 16)
      cd.writeUInt32LE(e.compSize, 20)
      cd.writeUInt32LE(e.uncompSize, 24)
      cd.writeUInt16LE(e.nameBuf.length, 28)
      cd.writeUInt16LE(0, 30)          // extra length
      cd.writeUInt16LE(0, 32)          // comment length
      cd.writeUInt16LE(0, 34)          // disk number start
      cd.writeUInt16LE(0, 36)          // internal attrs
      cd.writeUInt32LE(0, 38)          // external attrs
      cd.writeUInt32LE(e.offset, 42)   // relative offset of local header
      cdChunks.push(cd, e.nameBuf)
      cdSize += 46 + e.nameBuf.length
    }

    const cdOffset = this.offset
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)  // end of central dir signature
    eocd.writeUInt16LE(0, 4)           // disk number
    eocd.writeUInt16LE(0, 6)           // disk with central dir
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdOffset, 14)
    eocd.writeUInt16LE(0, 20)          // comment length

    return Buffer.concat([...this.chunks, ...cdChunks, eocd])
  }
}

// ===== XML/HTML 工具 =====
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 纯文本正文 → 段落 HTML（空行分段，段内换行转 <br/>） */
function paragraphsToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
}

// ===== EPUB 构建 =====
export interface EpubChapter {
  title: string
  content: string
}

export interface EpubOptions {
  title: string
  author: string
  language?: string
  chapters: EpubChapter[]
}

/** 构建 EPUB，返回可直接写盘的二进制 Buffer */
export function buildEpub(opts: EpubOptions): Buffer {
  const language = opts.language || 'zh-CN'
  const title = opts.title || '未命名'
  const author = opts.author || '佚名'
  const uid = `urn:uuid:${randomUUID()}`
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

  const zip = new ZipBuilder()

  // 1) mimetype —— 必须首个、且 STORED（不压缩）
  zip.add('mimetype', Buffer.from('application/epub+zip', 'utf-8'), true)

  // 2) container.xml
  zip.add(
    'META-INF/container.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
      'utf-8',
    ),
  )

  // 3) 样式
  zip.add(
    'OEBPS/style.css',
    Buffer.from(
      `body { font-family: serif; line-height: 1.8; margin: 1em 1.2em; }
h1 { font-size: 1.3em; text-align: center; margin: 1.4em 0 1em; }
p { text-indent: 2em; margin: 0 0 0.6em; }`,
      'utf-8',
    ),
  )

  // 4) 各章正文
  const chapterFiles = opts.chapters.map((ch, i) => {
    const id = `chap${i + 1}`
    const file = `${id}.xhtml`
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}">
<head><meta charset="utf-8"/><title>${escapeXml(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h1>${escapeXml(ch.title)}</h1>
${paragraphsToHtml(ch.content)}
</body></html>`
    zip.add(`OEBPS/${file}`, Buffer.from(xhtml, 'utf-8'))
    return { id, file, title: ch.title }
  })

  // 5) content.opf
  const manifestItems = chapterFiles
    .map((c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`)
    .join('\n    ')
  const spineItems = chapterFiles.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`
  zip.add('OEBPS/content.opf', Buffer.from(opf, 'utf-8'))

  // 6) nav.xhtml（EPUB3 导航）
  const navLis = chapterFiles
    .map((c) => `<li><a href="${c.file}">${escapeXml(c.title)}</a></li>`)
    .join('\n      ')
  zip.add(
    'OEBPS/nav.xhtml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>目录</h1>
    <ol>
      ${navLis}
    </ol>
  </nav>
</body></html>`,
      'utf-8',
    ),
  )

  // 7) toc.ncx（EPUB2 兼容）
  const navPoints = chapterFiles
    .map(
      (c, i) =>
        `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`,
    )
    .join('\n    ')
  zip.add(
    'OEBPS/toc.ncx',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uid}"/></head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`,
      'utf-8',
    ),
  )

  return zip.finish()
}
