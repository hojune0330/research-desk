const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    // Only global unicast, excluding transition/documentation address ranges.
    return /^[23][0-9a-f]{3}:/.test(value) && !/^2001:(0*:|db8:|10:|20:)/.test(value) && !/^2002:|^3fff:/.test(value);
  }
  return false;
}
function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('올바른 웹 주소를 입력해 주세요.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) {
    throw new Error('공개 HTTP/HTTPS 주소만 지원합니다.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((net.isIP(host) && !isPublicAddress(host)) || (!net.isIP(host) && (!host.includes('.') || /\.(local|internal|localhost)$/.test(host)))) throw new Error('공개 웹 주소만 지원합니다.');
  url.hash = ''; return url;
}
async function collectPublicPage(value, signal, depth = 0) {
  if (depth > 4) throw new Error('주소 이동이 너무 많아 수집하지 않았습니다.');
  const url = publicUrl(value), host = url.hostname.replace(/^\[|\]$/g, '');
  if (signal?.aborted) throw new Error('작업을 중지했습니다.');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('내부 네트워크 주소는 수집하지 않습니다.');
  const chosen = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, timeout: 20_000,
      headers: { 'User-Agent': 'ResearchDesk/0.2', Accept: 'text/html,text/plain,application/pdf', 'Accept-Encoding': 'identity' },
      // Pin the checked address to prevent DNS rebinding between validation and connect.
      lookup: (_hostname, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family)
    }, resolve);
    request.on('error', () => reject(new Error(signal?.aborted ? '작업을 중지했습니다.' : '웹 페이지에 연결하지 못했습니다.')));
    request.on('timeout', () => request.destroy(new Error('timeout')));
  });
  if ([301,302,303,307,308].includes(response.statusCode)) {
    const next = response.headers.location; response.destroy();
    if (!next) throw new Error('이동 주소가 없습니다.');
    return collectPublicPage(new URL(next, url).toString(), signal, depth + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new Error('웹 페이지를 가져오지 못했습니다. 로그인이나 접근 제한을 확인해 주세요.'); }
  const type = String(response.headers['content-type'] || '').toLowerCase();
  const extension = type.includes('application/pdf') ? '.pdf' : type.includes('text/plain') ? '.txt' : type.includes('html') ? '.html' : null;
  if (!extension) { response.destroy(); throw new Error('HTML·텍스트·PDF 웹 자료만 지원합니다.'); }
  const buffers = []; let size = 0;
  const deadline = setTimeout(() => response.destroy(new Error('timeout')), 20_000);
  try {
    for await (const buffer of response) {
      size += buffer.length;
      if (size > 10 * 1024 * 1024) { response.destroy(); throw new Error('웹 자료는 10MB까지 지원합니다.'); }
      buffers.push(buffer);
    }
  } finally { clearTimeout(deadline); }
  return { buffer: Buffer.concat(buffers), extension, url: url.toString() };
}
module.exports = { isPublicAddress, publicUrl, collectPublicPage };
