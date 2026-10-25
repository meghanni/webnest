const api = window.webnest;
const list = document.querySelector('#apps');
const empty = document.querySelector('#empty');
const themeButton = document.querySelector('#theme-button');
const themeCurrent = document.querySelector('#theme-current');
const themeOptions = document.querySelector('#theme-options');
const dialog = document.querySelector('#add-dialog');
const form = document.querySelector('#add-form');
const error = document.querySelector('#form-error');
const toast = document.querySelector('#toast');
const fetchIconButton = document.querySelector('#fetch-icon');
const iconStatus = document.querySelector('#icon-status');
let removeId = null;
let editingId = null;
let toastTimer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('shown'), 2600);
}

function render(state) {
  setThemeSelection(state.theme);
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('#app-count').textContent = state.apps.length;
  empty.hidden = state.apps.length > 0;
  list.hidden = state.apps.length === 0;
  list.replaceChildren();
  for (const item of state.apps) {
    const card = document.createElement('article');
    card.className = 'app-card';
    const icon = document.createElement('div');
    icon.className = 'app-icon';
    if (item.icon) {
      const image = document.createElement('img');
      image.src = item.icon;
      image.alt = '';
      icon.append(image);
    } else icon.textContent = item.name.slice(0, 1).toUpperCase();
    const info = document.createElement('div');
    info.className = 'app-info';
    const title = document.createElement('h3'); title.textContent = item.name;
    const host = document.createElement('p');
    try { host.textContent = new URL(item.url).hostname; } catch { host.textContent = item.url; }
    const trayLabel = document.createElement('label'); trayLabel.className = 'tray-toggle';
    const trayCheckbox = document.createElement('input'); trayCheckbox.type = 'checkbox'; trayCheckbox.checked = item.keepInTray === true;
    trayCheckbox.setAttribute('aria-label', `Keep ${item.name} in the system tray when hidden`);
    trayCheckbox.addEventListener('change', async () => {
      const enabled = trayCheckbox.checked;
      trayCheckbox.disabled = true;
      try {
        await api.setAppTray(item.id, enabled);
        notify(enabled ? `${item.name} will stay in the tray when hidden` : `${item.name} will close when its window is closed`);
      } catch (exception) {
        trayCheckbox.checked = !enabled;
        notify(exception.message || 'Could not update this app');
      } finally { trayCheckbox.disabled = false; }
    });
    const trayText = document.createElement('span'); trayText.textContent = 'Keep in tray';
    trayLabel.append(trayCheckbox, trayText);
    info.append(title, host, trayLabel);
    const open = document.createElement('button'); open.className = 'open-app'; open.textContent = 'Open';
    open.addEventListener('click', () => api.openApp(item.id));
    const edit = document.createElement('button'); edit.className = 'edit-app'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => openEdit(item));
    const remove = document.createElement('button'); remove.className = 'remove-app'; remove.textContent = '×'; remove.title = `Remove ${item.name}`; remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => { removeId = item.id; document.querySelector('#confirm-dialog').showModal(); });
    const actions = document.createElement('div'); actions.className = 'card-actions'; actions.append(edit, open, remove);
    card.append(icon, info, actions);
    list.append(card);
  }
}

let selectedIcon = '';
function clearIcon() {
  selectedIcon = '';
  document.querySelector('#app-icon').value = '';
  document.querySelector('#icon-preview').hidden = true;
  iconStatus.textContent = '';
}
document.querySelector('#app-icon').addEventListener('change', () => {
  const file = document.querySelector('#app-icon').files[0];
  if (!file) return;
  const extension = file.name.split('.').pop().toLowerCase();
  const isIco = extension === 'ico';
  if (!isIco && !['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(file.type)) {
    error.textContent = 'Choose a PNG, JPG, WEBP, or ICO icon.'; clearIcon(); return;
  }
  if (file.size > 1_000_000) { error.textContent = 'Choose an icon smaller than 1 MB.'; clearIcon(); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    selectedIcon = isIco ? dataUrl.replace(/^data:[^;,]+;base64,/i, 'data:image/x-icon;base64,') : dataUrl;
    document.querySelector('#icon-preview-image').src = selectedIcon;
    document.querySelector('#icon-filename').textContent = file.name;
    document.querySelector('#icon-preview').hidden = false;
    iconStatus.textContent = 'Uploaded icon selected';
  };
  reader.readAsDataURL(file);
});
document.querySelector('#clear-icon').addEventListener('click', clearIcon);
fetchIconButton.addEventListener('click', async () => {
  const urlInput = document.querySelector('#app-url');
  if (!urlInput.reportValidity()) return;
  fetchIconButton.disabled = true;
  iconStatus.textContent = 'Looking for the website icon…';
  try {
    selectedIcon = await api.fetchIcon(urlInput.value);
    document.querySelector('#app-icon').value = '';
    document.querySelector('#icon-preview-image').src = selectedIcon;
    document.querySelector('#icon-filename').textContent = 'Website icon';
    document.querySelector('#icon-preview').hidden = false;
    iconStatus.textContent = 'Website icon ready';
  } catch (exception) {
    iconStatus.textContent = exception.message || 'Could not fetch an icon';
  } finally { fetchIconButton.disabled = false; }
});
function openAdd() {
  editingId = null;
  error.textContent = '';
  form.reset();
  clearIcon();
  document.querySelector('#dialog-symbol').textContent = '＋';
  document.querySelector('#dialog-title').textContent = 'Add a web app';
  document.querySelector('#dialog-copy').textContent = 'Give a website a name. WebNest will keep its sign-in and browsing data in its own session.';
  document.querySelector('#submit-app').innerHTML = 'Create app <span>→</span>';
  dialog.showModal();
  setTimeout(() => document.querySelector('#app-name').focus(), 30);
}
function openEdit(item) {
  editingId = item.id;
  error.textContent = '';
  form.reset();
  clearIcon();
  form.elements.name.value = item.name;
  form.elements.url.value = item.url;
  form.elements.openLinksInTabs.checked = item.openLinksInTabs === true;
  if (form.elements.openExternalLinksInBrowser) form.elements.openExternalLinksInBrowser.checked = item.openExternalLinksInBrowser === true;
  form.elements.allowCamera.checked = item.allowCamera === true;
  form.elements.allowMicrophone.checked = item.allowMicrophone === true;
  form.elements.allowNotifications.checked = item.allowNotifications === true;
  selectedIcon = item.icon || '';
  if (selectedIcon) {
    document.querySelector('#icon-preview-image').src = selectedIcon;
    document.querySelector('#icon-filename').textContent = 'Current app icon';
    document.querySelector('#icon-preview').hidden = false;
    iconStatus.textContent = 'Current icon selected';
  }
  document.querySelector('#dialog-symbol').textContent = '✎';
  document.querySelector('#dialog-title').textContent = 'Edit app';
  document.querySelector('#dialog-copy').textContent = 'Update the app name, website address, or icon.';
  document.querySelector('#submit-app').innerHTML = 'Save changes <span>→</span>';
  dialog.showModal();
  setTimeout(() => document.querySelector('#app-name').focus(), 30);
}
document.querySelectorAll('#add-top, #add-empty').forEach((button) => button.addEventListener('click', openAdd));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelector('#confirm-remove').addEventListener('click', async () => {
  if (removeId) await api.removeApp(removeId);
  removeId = null;
  document.querySelector('#confirm-dialog').close();
  notify('App removed from your collection');
});
function setThemeSelection(value) {
  const labels = { system: 'System appearance', light: 'Light appearance', dark: 'Dark appearance' };
  themeCurrent.textContent = labels[value] || labels.system;
  for (const option of themeOptions.querySelectorAll('[role="option"]')) {
    option.setAttribute('aria-selected', String(option.dataset.themeValue === value));
  }
}

function closeThemeOptions(returnFocus = false) {
  themeOptions.hidden = true;
  themeButton.setAttribute('aria-expanded', 'false');
  if (returnFocus) themeButton.focus();
}

function openThemeOptions() {
  themeOptions.hidden = false;
  themeButton.setAttribute('aria-expanded', 'true');
  themeOptions.querySelector('[aria-selected="true"]')?.focus();
}

themeButton.addEventListener('click', () => {
  if (themeOptions.hidden) openThemeOptions();
  else closeThemeOptions();
});
themeOptions.addEventListener('click', async (event) => {
  const option = event.target.closest('[data-theme-value]');
  if (!option) return;
  const value = option.dataset.themeValue;
  setThemeSelection(value);
  closeThemeOptions(true);
  try { await api.setTheme(value); }
  catch (exception) { notify(exception.message || 'Could not change the appearance'); }
});
themeButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openThemeOptions();
  }
});
themeOptions.addEventListener('keydown', (event) => {
  const options = [...themeOptions.querySelectorAll('[role="option"]')];
  const currentIndex = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeThemeOptions(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    options[(currentIndex + direction + options.length) % options.length]?.focus();
  } else if (event.key === 'Tab') closeThemeOptions();
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.theme-picker') && !themeOptions.hidden) closeThemeOptions();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = {
      name: form.elements.name.value,
      url: form.elements.url.value,
      icon: selectedIcon,
      openLinksInTabs: form.elements.openLinksInTabs.checked,
      openExternalLinksInBrowser: form.elements.openExternalLinksInBrowser ? form.elements.openExternalLinksInBrowser.checked : false,
      allowCamera: form.elements.allowCamera.checked,
      allowMicrophone: form.elements.allowMicrophone.checked,
      allowNotifications: form.elements.allowNotifications.checked
    };
    if (editingId) {
      await api.updateApp(editingId, data);
      notify('App details updated');
    } else {
      await api.addApp(data);
      notify('Your app is ready');
    }
    dialog.close();
  } catch (exception) { error.textContent = exception.message || 'Please check the app details and try again.'; }
});
document.querySelector('#export').addEventListener('click', async () => { if (await api.exportConfig()) notify('Your setup has been exported'); });
document.querySelector('#import').addEventListener('click', async () => {
  try { if (await api.importConfig()) notify('Your setup has been imported'); }
  catch (exception) { notify(exception.message || 'Could not import that file'); }
});
api.getState().then(render).catch(() => notify('Could not load your apps'));
api.onState(render);
