import { getSettings } from './settings.js';

// Paper sizes in inches (required by the Chrome DevTools Protocol).
const PAPER = {
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
  Letter: [8.5, 11],
  Legal: [8.5, 14]
};
const MARGINS = { none: 0, small: 0.25, normal: 0.4, wide: 0.8 };
// Chrome caps a PDF page at roughly 200 inches (14,400 pt).
const MAX_PAGE_IN = 200;

const busyTabs = new Set();
// File names we want for our own downloads. Chrome sometimes ignores the
// `filename` option for data: URLs (e.g. when another extension manages
// downloads) and falls back to "download", so we also set it here.
const pendingNames = [];

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id && pendingNames.length) {
    suggest({ filename: pendingNames.shift(), conflictAction: 'uniquify' });
  } else {
    suggest();
  }
});

// ---------- Entry points ----------

chrome.action.onClicked.addListener((tab) => savePdf(tab));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-pdf',
      title: 'Save page as PDF',
      contexts: ['page', 'frame', 'selection', 'link', 'image']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-pdf') savePdf(tab);
});

// ---------- Main flow ----------

async function savePdf(tab) {
  if (!tab?.id || busyTabs.has(tab.id)) return;
  const url = tab.url || '';

  // Already a PDF file: just download the original.
  if (/^https?:.*\.pdf(\?|#|$)/i.test(url)) {
    await chrome.downloads.download({ url });
    return;
  }

  const blocked = blockedReason(url);
  if (blocked) {
    await fail(tab.id, blocked);
    return;
  }

  busyTabs.add(tab.id);
  await badge(tab.id, '…', '#2e7d32');
  const target = { tabId: tab.id };
  let attached = false;

  try {
    const s = await getSettings();

    if (s.scrollFirst) await autoScroll(tab.id).catch(() => {});

    await chrome.debugger.attach(target, '1.3');
    attached = true;

    if (s.screenMedia || s.singlePage) {
      await cdp(target, 'Emulation.setEmulatedMedia', { media: 'screen' });
    }

    // Freeze full-viewport (100vh) blocks, otherwise they stretch to the
    // full height of the PDF page.
    await freezeViewportHeights(target).catch((e) => console.warn('freeze', e));

    // Make sure images and web fonts have finished loading, so the PDF has
    // no empty image boxes or fallback fonts.
    await waitForAssets(target).catch((e) => console.warn('assets', e));

    const params = await buildParams(target, s);
    let { data } = await cdp(target, 'Page.printToPDF', params);

    // The print layout can be slightly taller than the screen layout, which
    // pushes the tail (usually the footer) onto a second, nearly empty page.
    // Grow the page and print again until everything fits on one sheet.
    for (let i = 0; s.singlePage && i < 4; i++) {
      const pages = countPdfPages(data);
      if (pages <= 1) break;
      const grow = params.paperHeight * (pages - 1) / pages * 0.5 + 0.5 * (i + 1);
      const newH = params.paperHeight + grow;
      if (newH > MAX_PAGE_IN) {
        const k = MAX_PAGE_IN / newH;
        params.scale = Math.max(0.1, params.scale * k);
        params.paperWidth *= k;
        params.paperHeight = MAX_PAGE_IN;
      } else {
        params.paperHeight = newH;
      }
      ({ data } = await cdp(target, 'Page.printToPDF', params));
    }
    await evaluate(target, 'window.__pdfRestore && window.__pdfRestore()').catch(() => {});

    const download = (filename) => (pendingNames.push(filename), chrome.downloads.download({
      url: 'data:application/pdf;base64,' + data,
      filename,
      saveAs: s.saveAs,
      conflictAction: 'uniquify'
    }).catch((e) => { pendingNames.pop(); throw e; }));
    let filename = makeFileName(tab.title, url);
    try {
      await download(filename);
    } catch (e) {
      // Fallback when the OS rejects the file name (rare encoding issues).
      if (!/filename/i.test(String(e?.message))) throw e;
      filename = 'page-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.pdf';
      await download(filename);
    }

    await badge(tab.id, '✓', '#2e7d32', 2500);
    if (s.notifyOnSave && !s.saveAs) notify('PDF saved', filename, 4000);
  } catch (err) {
    console.error(err);
    await fail(tab.id, humanError(err));
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
    busyTabs.delete(tab.id);
  }
}

async function buildParams(target, s) {
  const margin = s.singlePage ? 0 : MARGINS[s.margins] ?? 0.4;
  const [w, h] = PAPER[s.paper] || PAPER.A4;

  const params = {
    printBackground: s.background,
    landscape: s.landscape,
    paperWidth: w,
    paperHeight: h,
    marginTop: margin,
    marginBottom: margin,
    marginLeft: margin,
    marginRight: margin,
    preferCSSPageSize: false,
    generateTaggedPDF: true,       // accessible PDF, correct text copying
    generateDocumentOutline: true  // bookmarks from page headings
  };

  if (s.headerFooter && !s.singlePage) {
    const style = 'font-size:8px;width:100%;padding:0 0.4in;color:#555;font-family:sans-serif;';
    params.displayHeaderFooter = true;
    params.headerTemplate =
      `<div style="${style}display:flex;justify-content:space-between">` +
      `<span class="date"></span><span class="title"></span></div>`;
    params.footerTemplate =
      `<div style="${style}display:flex;justify-content:space-between">` +
      `<span class="url"></span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
    params.marginTop = Math.max(params.marginTop, 0.5);
    params.marginBottom = Math.max(params.marginBottom, 0.5);
  }

  const viewport = await getViewport(target);

  if (s.singlePage) {
    // The whole page on one sheet as wide as the browser window.
    const m = await cdp(target, 'Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    const docH = await evaluate(target, `Math.max(
      document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
      document.documentElement.getBoundingClientRect().height)`).catch(() => 0);
    const wIn = Math.max(viewport.width, 320) / 96;
    const hIn = Math.max(size.height, docH || 0, 320) / 96 + 0.1;
    const scale = Math.max(0.1, Math.min(1, MAX_PAGE_IN / hIn));
    Object.assign(params, {
      landscape: false,
      paperWidth: wIn * scale,
      paperHeight: Math.min(hIn * scale, MAX_PAGE_IN),
      scale
    });
  } else if (s.fitWidth) {
    // Scale so the full window width fits the sheet: the site keeps its
    // desktop layout instead of switching to the mobile one.
    const pageW = (s.landscape ? h : w) - params.marginLeft - params.marginRight;
    params.scale = Math.max(0.1, Math.min(1, (pageW * 96) / Math.max(viewport.width, 320)));
  }

  return params;
}

// Scroll to the bottom so lazy-loaded images get loaded.
async function autoScroll(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const start = Date.now();
      const startY = window.scrollY;
      let lastHeight = -1;
      while (Date.now() - start < 15000) {
        window.scrollBy(0, window.innerHeight * 0.9);
        await sleep(120);
        const h = document.documentElement.scrollHeight;
        if (window.innerHeight + window.scrollY >= h - 2) {
          if (h === lastHeight) break;
          lastHeight = h;
          await sleep(400); // give content time to load
        }
      }
      // Force-load images marked loading="lazy".
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => (img.loading = 'eager'));
      window.scrollTo(0, startY);
      await sleep(300);
    }
  });
}

// ---------- Helpers ----------

async function evaluate(target, expression) {
  const r = await cdp(target, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
}

async function getViewport(target) {
  return evaluate(target,
    '({ width: document.documentElement.clientWidth || innerWidth, height: innerHeight, outer: innerWidth })');
}

// Find elements whose height depends on the viewport height: temporarily
// double the viewport and see which ones change, then pin their height.
async function freezeViewportHeights(target) {
  const vp = await getViewport(target);
  await evaluate(target, `(() => {
    window.__pdfProbe = [...document.querySelectorAll('body *')]
      .map((el) => [el, el.getBoundingClientRect().height]);
  })()`);
  await cdp(target, 'Emulation.setDeviceMetricsOverride', {
    width: vp.outer, height: Math.max(vp.height * 2, 1600), deviceScaleFactor: 0, mobile: false
  });
  try {
    await evaluate(target, `new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))`);
    await evaluate(target, `(() => {
      const saved = [];
      for (const [el, h] of window.__pdfProbe || []) {
        if (!el.isConnected || h < 1) continue;
        if (Math.abs(el.getBoundingClientRect().height - h) > 1) saved.push([el, el.style.cssText, h]);
      }
      for (const [el, , h] of saved) {
        for (const p of ['height', 'min-height', 'max-height']) el.style.setProperty(p, h + 'px', 'important');
      }
      delete window.__pdfProbe;
      window.__pdfRestore = () => {
        for (const [el, css] of saved) el.style.cssText = css;
        delete window.__pdfRestore;
      };
      return saved.length;
    })()`);
  } finally {
    await cdp(target, 'Emulation.clearDeviceMetricsOverride');
  }
}

// Page count of a base64 PDF: count the /Type /Page objects.
function countPdfPages(base64) {
  const bin = atob(base64);
  const m = bin.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return m ? m.length : 1;
}

// Wait (up to 8 s) for pending <img> elements and web fonts to load.
function waitForAssets(target, timeoutMs = 8000) {
  return evaluate(target, `(async () => {
    const pending = [...document.images]
      .filter((img) => !img.complete && img.getAttribute('src') !== '')
      .map((img) => new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }));
    if (document.fonts) pending.push(document.fonts.ready);
    await Promise.race([
      Promise.all(pending),
      new Promise((r) => setTimeout(r, ${timeoutMs}))
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

function cdp(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

function blockedReason(url) {
  if (!/^(https?|file):/i.test(url)) {
    return 'Chrome does not allow extensions to capture internal pages (chrome://, settings, the New Tab page, etc.).';
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    return 'Chrome does not allow extensions to run on Chrome Web Store pages.';
  }
  return null;
}

function humanError(err) {
  const msg = String(err?.message || err);
  if (/Another debugger is already attached/i.test(msg)) {
    return 'Another debugger (DevTools or another extension) is attached to this tab. Close it and try again.';
  }
  if (/file:\/\//i.test(msg)) {
    return 'To save local files, enable "Allow access to file URLs" in the extension details.';
  }
  if (/Cannot access|Cannot attach|chrome-extension/i.test(msg)) {
    return 'Chrome does not allow access to this page.';
  }
  return 'Could not create the PDF: ' + msg +
    '. Tip: you can still use Ctrl+P (⌘P) → Save as PDF → More settings → Background graphics.';
}

function makeFileName(title, url) {
  let name = (title || '').trim();
  if (!name) {
    try { name = new URL(url).hostname; } catch { name = 'page'; }
  }
  name = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ') // characters forbidden on Windows
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
  return (name || 'page') + '.pdf';
}

async function badge(tabId, text, color, clearAfterMs) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (clearAfterMs) {
      setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), clearAfterMs);
    }
  } catch { /* the tab may have been closed */ }
}

function notify(title, message, clearAfterMs) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title, message }, (id) => {
    if (clearAfterMs && id) setTimeout(() => chrome.notifications.clear(id), clearAfterMs);
  });
}

async function fail(tabId, message) {
  await badge(tabId, '!', '#c62828', 4000);
  notify('Could not save PDF', message);
}
