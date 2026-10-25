const tabsElement = document.getElementById('tabs');

function render(state) {
  tabsElement.replaceChildren();
  for (const tab of state.tabs) {
    const item = document.createElement('div');
    item.className = 'tab';
    const active = tab.id === state.activeId;
    item.dataset.active = String(active);
    const select = document.createElement('button');
    select.className = 'tab-select';
    select.type = 'button';
    select.role = 'tab';
    select.setAttribute('aria-selected', String(active));
    select.setAttribute('aria-label', tab.title);
    select.title = tab.title;
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      window.webnestTabs.close(tab.id);
    });
    select.append(title);
    select.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); console.log('tab mousedown', tab.id); window.webnestTabs.select(tab.id); });
    select.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); console.log('tab click', tab.id); window.webnestTabs.select(tab.id); });
    close.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); window.webnestTabs.close(tab.id); });
    item.append(select, close);
    tabsElement.append(item);
  }
}

window.webnestTabs.onState(render);
document.getElementById('new-tab').addEventListener('click', () => window.webnestTabs.create());
