const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const sharp = require('sharp');

// Local resource protection, not claims about any model's input limits.
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
function fail(status, message, code = 'IMAGE_EDIT_ERROR') {
  const error = new Error(message);
  Object.assign(error, { status, code });
  throw error;
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function localFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || /^[A-Za-z]:/.test(relative)) {
    fail(400, '无效的图片路径');
  }
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) fail(400, '图片路径超出存储目录');
  let actual;
  try { actual = fs.realpathSync(candidate); } catch (_) { fail(404, '原图文件不存在'); }
  if (!inside(fs.realpathSync(root), actual)) fail(400, '图片路径超出存储目录');
  if (!fs.statSync(actual).isFile()) fail(400, '原图不是文件');
  return actual;
}
const restrictedV6 = new net.BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  restrictedV6.addSubnet(address, prefix, 'ipv6');
}
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Exclude transition networks too: 6to4/Teredo can embed private IPv4 destinations.
  return net.isIP(address) === 6 && /^[23]/.test(address) && !restrictedV6.check(address, 'ipv6');
}
async function remoteBuffer(raw, redirects = 0, signal = AbortSignal.timeout(30000)) {
  if (redirects > 5) fail(400, '原图重定向过多');
  let url;
  try { url = new URL(raw); } catch (_) { fail(400, '无效的原图地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(400, '不支持的原图地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  let onAbort;
  let addresses;
  try {
    addresses = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally { signal.removeEventListener('abort', onAbort); }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) fail(400, '远程原图不能指向本机或内网地址');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Pin the validated address; no second DNS lookup/rebinding during connect.
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal,
      lookup: (_host, options, callback) => options.all
        ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, addresses[0].family),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(remoteBuffer(new URL(res.headers.location, url).href, redirects + 1, signal));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('无法下载原图')); return; }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(Object.assign(new Error('图片超过本地 16MB 限制'), { status: 413 }));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    request.on('error', reject);
  });
}
async function sourceBuffer(root, source) {
  let value = source.local_path || source.url || '';
  if (typeof value !== 'string' || !value) fail(400, '缺少原图');
  if (value.startsWith('data:')) {
    if (value.length > MAX_BYTES * 1.4) fail(413, '原图过大');
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
    if (!match) fail(400, '不支持的原图数据');
    return Buffer.from(match[1], 'base64');
  }
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.startsWith('/static/')) {
      value = decodeURIComponent(url.pathname.slice('/static/'.length));
    } else return remoteBuffer(value);
  } else if (value.startsWith('/static/')) {
    value = decodeURIComponent(value.slice('/static/'.length).split('?')[0]);
  }
  const filename = localFile(root, value);
  if (fs.statSync(filename).size > MAX_BYTES) fail(413, '图片超过本地 16MB 限制');
  return fs.readFileSync(filename);
}
async function decodeImage(buffer, normalize = true) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail(400, '图片内容为空');
  if (buffer.length > MAX_BYTES) fail(413, '图片超过本地 16MB 限制');
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1) fail(400, '仅支持静态 PNG、JPEG、WebP 图片');
    if (normalize) {
      const out = await image.rotate().png().toBuffer({ resolveWithObject: true });
      if (out.data.length > MAX_BYTES) fail(413, '规范化后的图片过大');
      return { buffer: out.data, width: out.info.width, height: out.info.height, extension: 'png' };
    }
    // Decode fully, not just headers. Preserve the model's entire file when adopting.
    await image.raw().toBuffer();
    const rotated = [5, 6, 7, 8].includes(meta.orientation);
    return { buffer, width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height, extension: meta.format === 'jpeg' ? 'jpg' : meta.format };
  } catch (e) {
    if (e.status) throw e;
    fail(400, '无法解码图片或图片像素量过大');
  }
}
function destinationFile(root, relative) {
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) fail(400, '目标路径超出存储目录');
  let existing = path.dirname(candidate);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const parent = fs.realpathSync(existing);
  const actualRoot = fs.realpathSync(root);
  if (parent !== actualRoot && !inside(actualRoot, parent)) fail(400, '目标目录链接超出存储目录');
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  return candidate;
}
function writeFile(filename, buffer) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const partial = filename + '.part';
  const fd = fs.openSync(partial, 'wx');
  try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(partial, filename);
}
module.exports = { MAX_BYTES, MAX_PIXELS, fail, localFile, sourceBuffer, decodeImage, writeFile, destinationFile, publicAddress };
