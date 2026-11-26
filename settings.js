// Default settings shared by the service worker and the options page.
export const DEFAULTS = {
  paper: 'A4',          // A4 | A3 | A5 | Letter | Legal
  landscape: false,     // landscape orientation
  margins: 'normal',    // none | small | normal | wide
  background: true,     // print background colors and images
  screenMedia: true,    // screen look instead of the print stylesheet
  singlePage: true,     // whole page as one long sheet
  fitWidth: true,       // paged mode: keep desktop layout by fitting window width
  scrollFirst: true,    // scroll first so lazy images load
  headerFooter: false,  // header/footer: date, title, URL, page numbers
  saveAs: false         // ask where to save every time
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}
