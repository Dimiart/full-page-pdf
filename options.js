import { DEFAULTS, getSettings } from './settings.js';

const savedEl = document.getElementById('saved');
let timer;

const settings = await getSettings();
const pagedCard = document.getElementById('pagedCard');
const syncDim = () => pagedCard.classList.toggle('dim', document.getElementById('singlePage').checked);

for (const key of Object.keys(DEFAULTS)) {
  const el = document.getElementById(key);
  if (!el) continue;
  if (el.type === 'checkbox') el.checked = settings[key];
  else el.value = settings[key];

  el.addEventListener('change', async () => {
    const value = el.type === 'checkbox' ? el.checked : el.value;
    await chrome.storage.sync.set({ [key]: value });
    syncDim();
    savedEl.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => savedEl.classList.remove('show'), 1500);
  });
}

syncDim();
