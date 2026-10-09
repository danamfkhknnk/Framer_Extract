import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as cheerio from 'cheerio';

// Mirrors a site by actually loading it in a real browser and recording every
// response it makes, instead of statically scraping HTML (wget's approach).
// This is what lets us capture assets/components that only appear once the
// page's own JS runs (dynamic imports, lazy-loaded sections, etc.), and lets
// us properly rewrite `srcset` (wget mangles multi-candidate srcset values).
export async function mirrorSite(startUrl, outDir, { maxDepth = 2, perPageTimeoutMs = 30000, allowedHosts, signal } = {}) {
  const startUrlObj = new URL(startUrl);
  const rootHost = startUrlObj.hostname;

  // Scope to the site's own content + the asset CDNs it actually needs.
  // Deliberately excludes the Framer *editor/review* app (app.framerstatic.com,
  // api.framer.com, events.framer.com analytics, sentry.io, *.framercanvas.com)
  // which gets pulled in if a page happens to link to a real /edit route.
  const hostAllowlist = new Set(
    allowedHosts || [rootHost, 'framerusercontent.com', 'fonts.gstatic.com', 'fonts.googleapis.com']
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const urlMap = new Map(); // absolute url -> { localPath, isDocument }
  const redirects = []; // [fromUrl, toUrl]
  const pendingBodies = [];

  function localPathForAsset(urlStr) {
    const u = new URL(urlStr);
    let p = decodeURIComponent(u.pathname).replace(/^\//, '');
    if (p === '') p = 'index';
    const dir = path.dirname(p);
    let base = path.basename(p);
    if (u.search) {
      const hash = crypto.createHash('md5').update(u.search).digest('hex').slice(0, 8);
      const ext = path.extname(base);
      const name = ext ? base.slice(0, -ext.length) : base;
      base = `${name}.${hash}${ext}`;
    }
    const relDir = dir === '.' ? '' : dir;
    return path.join(u.hostname, relDir, base);
  }

  function localPathForDocument(urlStr) {
    const u = new URL(urlStr);
    let p = decodeURIComponent(u.pathname).replace(/^\//, '').replace(/\/$/, '');
    if (p === '') p = 'index';
    return `${p}.html`;
  }

  function relFromHtml(htmlLocalPath, targetLocalPath) {
    const fromDir = path.dirname(htmlLocalPath);
    let rel = path.relative(fromDir, targetLocalPath);
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel.split(path.sep).join('/');
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

  context.on('response', (response) => {
    const req = response.request();
    const resType = req.resourceType();
    const status = response.status();
    const urlStr = response.url();
    if (!urlStr.startsWith('http')) return;
    try {
      if (!hostAllowlist.has(new URL(urlStr).hostname)) return;
    } catch {
      return;
    }

    if (status >= 300 && status < 400) {
      const loc = response.headers()['location'];
      if (loc) {
        try {
          redirects.push([urlStr, new URL(loc, urlStr).href]);
        } catch {
          /* ignore malformed Location header */
        }
      }
      return;
    }
    if (status >= 400) return;
    if (urlMap.has(urlStr)) return;

    const isDocument = resType === 'document';
    const localPath = isDocument ? localPathForDocument(urlStr) : localPathForAsset(urlStr);
    urlMap.set(urlStr, { localPath, isDocument });

    pendingBodies.push(
      (async () => {
        try {
          const buf = await response.body();
          const fullPath = path.join(outDir, localPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, buf);
        } catch {
          // Response body can be unavailable for some (e.g. opaque/cached) responses; skip it.
        }
      })()
    );
  });

  try {
    const visited = new Set();
    const discoveredPageUrls = new Set([startUrl]);
    const queue = [{ url: startUrl, depth: 0 }];

    while (queue.length) {
      if (signal?.aborted) break;
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      const page = await context.newPage();
      try {
        // 'networkidle' can hang forever on sites with a persistent live-collab/
        // analytics connection, so wait for 'load' and settle with a fixed delay.
        await page.goto(url, { waitUntil: 'load', timeout: perPageTimeoutMs });
      } catch {
        // Keep going even if a page is slow/unreachable — we still capture whatever loaded.
      }
      await page.waitForTimeout(1500);
      try {
        await page.evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          let y = 0;
          const step = 400;
          const max = document.body.scrollHeight;
          while (y < max) {
            window.scrollTo(0, y);
            y += step;
            await sleep(60);
          }
          window.scrollTo(0, 0);
          await sleep(300);
        });
      } catch {
        /* page may have navigated away/closed */
      }
      await page.waitForTimeout(2000);

      if (depth < maxDepth) {
        let links = [];
        try {
          links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
        } catch {
          /* ignore */
        }
        for (const link of links) {
          try {
            const lu = new URL(link);
            if (lu.hostname !== rootHost) continue;
            // Skip Framer's own real editor/review route, not part of the published site.
            if (/^\/edit(\/|$)/.test(lu.pathname)) continue;
            lu.hash = '';
            const clean = lu.origin + lu.pathname + lu.search;
            if (!discoveredPageUrls.has(clean)) {
              discoveredPageUrls.add(clean);
              queue.push({ url: clean, depth: depth + 1 });
            }
          } catch {
            /* ignore malformed links */
          }
        }
      }

      await page.close();
    }

    await Promise.all(pendingBodies);
  } finally {
    await browser.close();
  }

  // Resolve redirect aliases so references to pre-redirect URLs also map correctly.
  for (const [from, to] of redirects) {
    const target = urlMap.get(to);
    if (target && !urlMap.has(from)) urlMap.set(from, target);
  }

  let rewrittenCount = 0;
  for (const [urlStr, info] of urlMap) {
    if (!info.isDocument) continue;
    const fullPath = path.join(outDir, info.localPath);
    if (!fs.existsSync(fullPath)) continue;
    const html = fs.readFileSync(fullPath, 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });

    const mapUrl = (raw) => {
      if (!raw) return raw;
      let abs;
      try {
        abs = new URL(raw, urlStr).href;
      } catch {
        return raw;
      }
      const target = urlMap.get(abs);
      if (!target) return raw;
      return relFromHtml(info.localPath, target.localPath);
    };

    $('[src]').each((_, el) => {
      $(el).attr('src', mapUrl($(el).attr('src')));
    });
    $('[srcset]').each((_, el) => {
      const v = $(el).attr('srcset');
      if (!v) return;
      const rewritten = v
        .split(',')
        .map((candidate) => {
          const trimmed = candidate.trim();
          const spaceIdx = trimmed.search(/\s/);
          if (spaceIdx === -1) return mapUrl(trimmed);
          return mapUrl(trimmed.slice(0, spaceIdx)) + trimmed.slice(spaceIdx);
        })
        .join(', ');
      $(el).attr('srcset', rewritten);
    });
    $('link[href]').each((_, el) => {
      const rel = $(el).attr('rel') || '';
      if (/preconnect|dns-prefetch/.test(rel)) return;
      $(el).attr('href', mapUrl($(el).attr('href')));
    });
    $('a[href]').each((_, el) => {
      $(el).attr('href', mapUrl($(el).attr('href')));
    });

    fs.writeFileSync(fullPath, $.html());
    rewrittenCount++;
  }

  return {
    pagesVisited: urlMap.size ? [...urlMap.values()].filter((v) => v.isDocument).length : 0,
    resourcesCaptured: urlMap.size,
    documentsRewritten: rewrittenCount,
  };
}
