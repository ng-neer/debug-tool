(function(){
    // Try popup first, fallback to overlay
    let debugWin = null;
    let isOverlay = false;

    try {
        debugWin = window.open('', 'IndexedDBDebugger', 'width=1000,height=700');
        if (debugWin && debugWin.document) {
            debugWin.document.write('test');
            debugWin.document.close();
        } else {
            throw new Error('Popup blocked');
        }
    } catch(e) {
        console.log('Using overlay mode for localhost');
        createOverlay();
        return;
    }

    // State for auto refresh in main window
    let autoRefresh = false;
    let autoInterval = null;
    let refreshInterval = 500; // Default 500ms

    function createOverlay() {
        isOverlay = true;

        // Remove existing overlay
        const existing = document.getElementById('indexeddb-overlay');
        if (existing) existing.remove();

        // Create overlay directly in current window
        const overlay = document.createElement('div');
        overlay.id = 'indexeddb-overlay';
        overlay.innerHTML = `
            <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:999999;font-family:monospace;">
                <div style="width:100%;height:100%;display:flex;flex-direction:column;">
                    <div style="background:#222;color:#eee;padding:10px;display:flex;justify-content:space-between;align-items:center;">
                        <span>🧪 <span id="dbNameVer">IndexedDB Debug Panel</span></span>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <button id="btnRefresh">Refresh</button>
                            <label style="cursor:pointer;">
                                <input type="checkbox" id="autoRefreshCb" checked> Auto-refresh
                            </label>
                            <input type="number" id="refreshIntervalInput" min="100" max="10000" step="100" value="500" style="width:60px;"> ms
                            <button onclick="document.getElementById('indexeddb-overlay').remove()" style="background:red;color:white;border:none;padding:5px 10px;cursor:pointer;">Close</button>
                        </div>
                    </div>
                    <div id="tabs" style="display:flex;border-bottom:1px solid darkgreen;"></div>
                    <div id="content" style="flex:1;padding:10px;overflow:auto;background:white;color:black;">Loading...</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Initialize overlay debugger
        initializeDebugger(overlay);
    }

    function initializeDebugger(container) {
        const tabsEl = container.querySelector('#tabs');
        const contentEl = container.querySelector('#content');
        const refreshBtn = container.querySelector('#btnRefresh');
        const autoRefreshCb = container.querySelector('#autoRefreshCb');
        const dbNameVerEl = container.querySelector('#dbNameVer');
        const refreshIntervalInput = container.querySelector('#refreshIntervalInput');

        let lastDbs = [];
        let currentTab = 'Main';
        let tableSortState = {};
        let lastSelected = { tableId: null, rowIdx: null, protocolId: null };
        let autoRefresh = true;
        let autoInterval = null;
        let refreshInterval = 500;
        let lastDataHash = null; // Store hash of last data to detect changes

        function formatJson(val) {
            // Handle File objects
            if (val instanceof File) {
                if (val.type.startsWith('image/') && val.size < 1024 * 1024) { // Less than 1MB
                    const url = URL.createObjectURL(val);
                    return {
                        html: `<div style="display:flex;align-items:center;gap:8px;">
                                <img src="${url}" style="max-width:50px;max-height:50px;border:1px solid #ccc;" 
                                     onload="this.nextSibling.style.display='block'" 
                                     onerror="this.style.display='none';this.nextSibling.style.display='block'">
                                <div style="display:none;">File: ${val.name} (${(val.size/1024).toFixed(1)}KB)</div>
                               </div>`,
                        className: 'file-image'
                    };
                } else {
                    return { html: `File: ${val.name} (${(val.size/1024).toFixed(1)}KB, ${val.type || 'unknown type'})`, className: 'file-object' };
                }
            }

            // Handle Blob objects
            if (val instanceof Blob) {
                if (val.type.startsWith('image/') && val.size < 1024 * 1024) { // Less than 1MB
                    const url = URL.createObjectURL(val);
                    return {
                        html: `<div style="display:flex;align-items:center;gap:8px;">
                                <img src="${url}" style="max-width:50px;max-height:50px;border:1px solid #ccc;" 
                                     onload="this.nextSibling.style.display='block'" 
                                     onerror="this.style.display='none';this.nextSibling.style.display='block'">
                                <div style="display:none;">Blob (${(val.size/1024).toFixed(1)}KB)</div>
                               </div>`,
                        className: 'blob-image'
                    };
                } else {
                    return { html: `Blob (${(val.size/1024).toFixed(1)}KB, ${val.type || 'unknown type'})`, className: 'blob-object' };
                }
            }

            if (Array.isArray(val)) {
                // Show summary, allow user to expand/collapse
                const summary = 'Array['+val.length+']';
                return { html: '<details><summary>'+summary+'</summary><pre>'+escapeHtml(JSON.stringify(val,null,2))+'</pre></details>', className: 'json-array' };
            }
            if (typeof val === 'object' && val !== null) {
                // Show summary, allow user to expand/collapse
                return { html: '<details><summary>Object</summary><pre>'+escapeHtml(JSON.stringify(val,null,2))+'</pre></details>', className: 'json-object' };
            }
            if (val === null) return { html: 'null', className: '' };
            if (typeof val === 'number' && val < 0) {
                return { html: '⚠️ ' + String(val), className: '' };
            }
            return { html: String(val), className: '' };
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function compareValues(a, b) {
            if (a === undefined) return 1;
            if (b === undefined) return -1;
            if (a === null) return 1;
            if (b === null) return -1;
            if (typeof a === "number" && typeof b === "number") return a - b;
            if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
            return String(a).localeCompare(String(b));
        }

        function generateDataHash(dbs) {
            // Create a hash of the data to detect changes
            if (!dbs || !dbs.length) return '';
            try {
                return JSON.stringify(dbs, (key, value) => {
                    // Skip Blob/File objects in hash as they can't be serialized
                    if (value instanceof Blob || value instanceof File) {
                        return `${value.constructor.name}:${value.size}:${value.type}`;
                    }
                    return value;
                });
            } catch(e) {
                return Math.random().toString(); // Force update if serialization fails
            }
        }

        function makeTable(rows, tableId) {
            if(!rows.length) return '<p>(Empty)</p>';
            const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
            let sortedRows = rows.slice();
            const sort = tableSortState[tableId];
            if (sort && sort.key) {
                sortedRows.sort((a, b) => {
                    const cmp = compareValues(a[sort.key], b[sort.key]);
                    return sort.dir === 'asc' ? cmp : -cmp;
                });
            }
            let html = '<table data-tableid="'+tableId+'"><thead><tr>';
            keys.forEach(k => {
                let thClass = (k==='version'?'version':'');
                if (sort && sort.key === k) thClass += ' sorted-' + sort.dir;
                html += '<th class="'+thClass+'" data-key="'+k+'">'+k+'</th>';
            });
            html += '</tr></thead><tbody>';
            sortedRows.forEach((row, idx) => {
                let trClass = '';
                if (lastSelected.tableId === tableId && lastSelected.rowIdx === idx) {
                    trClass = 'selected-row';
                } else if (lastSelected.protocolId !== null && row.protocolId !== undefined && row.protocolId === lastSelected.protocolId) {
                    trClass = 'related-row';
                }
                html += '<tr data-rowidx="'+idx+'" class="'+trClass+'">';
                keys.forEach(k => {
                    const formatted = formatJson(row[k]);
                    html += '<td class="'+(k==='version'?'version ':'')+formatted.className+'">'+formatted.html+'</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            return html;
        }

        function attachTableSortHandlers() {
            container.querySelectorAll('table[data-tableid]').forEach(table => {
                const tableId = table.getAttribute('data-tableid');
                table.querySelectorAll('th[data-key]').forEach(th => {
                    th.style.cursor = 'pointer';
                    th.onclick = function() {
                        const key = th.getAttribute('data-key');
                        let state = tableSortState[tableId] || {};
                        if (state.key === key) {
                            state.dir = state.dir === 'asc' ? 'desc' : 'asc';
                        } else {
                            state.key = key;
                            state.dir = 'asc';
                        }
                        tableSortState[tableId] = state;
                        showTab(lastDbs[0], currentTab);
                    };
                });
                table.querySelectorAll('tbody tr').forEach(tr => {
                    tr.onclick = function(e) {
                        // Prevent row selection when clicking on details/summary elements
                        if (e.target.tagName === 'SUMMARY' || e.target.closest('details')) {
                            return;
                        }
                        const rowIdx = parseInt(tr.getAttribute('data-rowidx'), 10);
                        const rows = getRowsForTableId(tableId);
                        const row = rows && rows[rowIdx];
                        let protocolId = null;
                        if (row && row.protocolId !== undefined) protocolId = row.protocolId;
                        else if (row && row.id !== undefined && tableId === 'protocols') protocolId = row.id;
                        else protocolId = null;
                        lastSelected = { tableId, rowIdx, protocolId };
                        showTab(lastDbs[0], currentTab);
                    };
                });
                // Stop event propagation for details/summary elements
                table.querySelectorAll('details, summary').forEach(el => {
                    el.addEventListener('click', function(e) {
                        e.stopPropagation();
                    });
                });
            });
        }

        function getRowsForTableId(tableId) {
            if (!lastDbs.length) return [];
            const db = lastDbs[0];
            return db.stores[tableId] || [];
        }

        function render(dbs) {
            // Check if data actually changed
            const newDataHash = generateDataHash(dbs);
            if (lastDataHash === newDataHash && lastDbs.length > 0 && dbs.length > 0) {
                // Data hasn't changed, no need to re-render
                return;
            }
            lastDataHash = newDataHash;

            lastDbs = dbs;
            if(!dbs.length) {
                contentEl.innerHTML = '<p>No IndexedDB databases</p>';
                tabsEl.innerHTML = '';
                dbNameVerEl.textContent = 'IndexedDB Debug Panel';
                return;
            }

            tabsEl.innerHTML = '';
            const tabNames = ['Main', 'Protocols', 'Header'];
            tabNames.forEach(tabName => {
                const tab = document.createElement('div');
                tab.style.cssText = 'padding:10px 20px;cursor:pointer;user-select:none;background:' + (tabName === currentTab ? 'white' : 'transparent');
                tab.textContent = tabName;
                tab.onclick = () => {
                    container.querySelectorAll('#tabs > div').forEach(t => t.style.background = 'transparent');
                    tab.style.background = 'white';
                    currentTab = tabName;
                    showTab(dbs[0], tabName);
                    dbNameVerEl.textContent = dbs[0].name + (dbs[0].version ? ' (v'+dbs[0].version+')' : '');
                };
                tabsEl.appendChild(tab);
            });

            showTab(dbs[0], currentTab);
            dbNameVerEl.textContent = dbs[0].name + (dbs[0].version ? ' (v'+dbs[0].version+')' : '');
        }

        function showTab(db, tabName) {
            let html = '';
            if(tabName === 'Header') {
                ['addresses', 'fibreOnLocations'].forEach(storeName => {
                    if(db.stores[storeName]) {
                        html += '<h3>'+storeName+' ('+db.stores[storeName].length+')</h3>'+makeTable(db.stores[storeName], storeName);
                    }
                });
            } else if(tabName === 'Main') {
                for(const storeName in db.stores){
                    if(storeName==='addresses'||storeName==='fibreOnLocations'||storeName==='protocols') continue;
                    html+='<h3>'+storeName+' ('+db.stores[storeName].length+')</h3>'+makeTable(db.stores[storeName], storeName);
                }
                // Remove duplicate syncQueries handling - it's already included in the loop above
            } else if(tabName === 'Protocols') {
                if(db.stores['protocols']) {
                    html += '<h3>protocols ('+db.stores['protocols'].length+')</h3>'+makeTable(db.stores['protocols'], 'protocols');
                } else {
                    html = '<p>(No data for protocols)</p>';
                }
            }
            contentEl.innerHTML = html || '<p>(Empty)</p>';
            setTimeout(attachTableSortHandlers, 0);
        }

        // Event handlers
        refreshBtn.onclick = sendAllIDBToOverlay;
        autoRefreshCb.onchange = function() {
            autoRefresh = this.checked;
            if (autoInterval) clearInterval(autoInterval);
            if (autoRefresh) {
                autoInterval = setInterval(sendAllIDBToOverlay, refreshInterval);
            }
        };
        refreshIntervalInput.onchange = function() {
            refreshInterval = parseInt(this.value, 10);
            if (autoRefresh) {
                if (autoInterval) clearInterval(autoInterval);
                autoInterval = setInterval(sendAllIDBToOverlay, refreshInterval);
            }
        };

        async function sendAllIDBToOverlay() {
            // Reset previous state to force re-search
            let infos = [];

            // Check if IndexedDB is available
            if (!window.indexedDB) {
                contentEl.innerHTML = '<p>IndexedDB not available</p>';
                return;
            }

            // Always try to get fresh database list
            if (indexedDB.databases) {
                try {
                    infos = await indexedDB.databases();
                } catch(e) {
                    console.warn('indexedDB.databases() failed:', e);
                    infos = [];
                }
            }

            // Always search for construction-documentation-ui-db
            let targetDb = null;
            if (infos.length) {
                targetDb = infos.find(db => db.name === 'construction-documentation-ui-db');
            }

            // If not found in list, try direct connection
            if (!targetDb) {
                try {
                    const testDb = await new Promise((resolve, reject) => {
                        const openReq = indexedDB.open('construction-documentation-ui-db');
                        openReq.onerror = () => reject(openReq.error);
                        openReq.onsuccess = () => resolve(openReq.result);
                        openReq.onupgradeneeded = () => {
                            openReq.result.close();
                            reject(new Error('Database does not exist'));
                        };
                    });

                    if (testDb.objectStoreNames.length > 0) {
                        targetDb = { name: 'construction-documentation-ui-db', version: testDb.version };
                    }
                    testDb.close();
                } catch(e) {
                    console.warn('Database search failed:', e);
                }
            }

            if (!targetDb) {
                contentEl.innerHTML = '<p>construction-documentation-ui-db not found. Make sure the database exists.</p>';
                return;
            }

            // Process the target database
            try {
                const db = await new Promise((resolve, reject) => {
                    const openReq = indexedDB.open(targetDb.name, targetDb.version);
                    openReq.onerror = () => reject(openReq.error);
                    openReq.onsuccess = () => resolve(openReq.result);
                });
                const stores = {};
                for(const storeName of db.objectStoreNames){
                    stores[storeName] = await new Promise(resolve => {
                        try {
                            const tx = db.transaction(storeName, 'readonly');
                            const req = tx.objectStore(storeName).getAll();
                            req.onsuccess=()=>resolve(req.result);
                            req.onerror=()=>resolve([]);
                        }catch{ resolve([]); }
                    });
                }
                db.close();
                render([{name: targetDb.name, stores, version: targetDb.version}]);
            } catch(e) {
                console.warn('Failed to open database:', targetDb.name, e);
                contentEl.innerHTML = '<p>Failed to open construction-documentation-ui-db</p>';
            }
        }

        // Start auto refresh
        sendAllIDBToOverlay();
        autoInterval = setInterval(sendAllIDBToOverlay, refreshInterval);
    }

    // Inject UI into popup
    debugWin.document.write(`
  <!DOCTYPE html>
  <html><head><title>IndexedDB Debug Panel</title>
    <style>
    body { font-family: monospace; margin:0; background:#f9f9f9; color:#222; }
    h1 { background:#222; color:#eee; margin:0; padding:10px; display:flex; justify-content:space-between; align-items:center; }
    .tabs { display:flex; border-bottom:1px solid darkgreen; }
    .tab { padding:10px 20px; cursor:pointer; user-select:none; }
    .tab.active { background:#fff; border-top:3px solid #007bff; font-weight:bold; }
    .content { padding:10px; max-height:85vh; overflow:auto; }
    table { border-collapse:collapse; width:100%; margin-bottom:1em; }
    th, td { border:1px solid #aaa; padding:6px; vertical-align:top; max-width:200px; word-break:break-word; overflow:auto; }
    th.version, td.version { border-color: black; background: darkseagreen !important; }
    th { background:#eee; resize: horizontal; }
    th.sorted-asc::after { content: " ▲"; }
    th.sorted-desc::after { content: " ▼"; }
    pre { white-space: pre-wrap; }
    #log { color: red; margin-top: 10px; }
    tr.selected-row { background: #ffe082 !important; }
    tr.related-row { background: #b3e5fc !important; }
    td.json-object { background: #e8f5e9 !important; }
    td.json-array { background: #e3f2fd !important; }
    td.json-object details, td.json-array details { display: block; }
    td.json-object summary, td.json-array summary { cursor: pointer; }
    .refresh-controls { display:flex; align-items:center; gap:10px; }
    .refresh-controls input[type="number"] { width: 60px; }
    td.file-image, td.blob-image { background: #f0f8ff !important; }
    td.file-object, td.blob-object { background: #fff8dc !important; }
    </style>
  </head><body>
    <h1 id="dbTitle">
      🧪 <span id="dbNameVer">IndexedDB Debug Panel</span>
      <div class="refresh-controls">
        <button id="btnRefresh">Refresh</button>
        <label style="user-select:none; cursor:pointer;">
          <input type="checkbox" id="autoRefreshCb" style="vertical-align:middle; margin-right:5px;">
          Auto-refresh
        </label>
        <label style="user-select:none;">
          <input type="number" id="refreshIntervalInput" min="100" max="10000" step="100" value="500" style="margin-left:5px;">
          ms
        </label>
      </div>
    </h1>
    <div class="tabs"></div>
    <div class="content">Loading...</div>
    <div id="log"></div>
    <script>
      const tabsEl = document.querySelector('.tabs');
      const contentEl = document.querySelector('.content');
      const logEl = document.getElementById('log');
      const refreshBtn = document.getElementById('btnRefresh');
      const autoRefreshCb = document.getElementById('autoRefreshCb');
      const dbNameVerEl = document.getElementById('dbNameVer');
      const refreshIntervalInput = document.getElementById('refreshIntervalInput');
      let lastDbs = [];
      let currentTab = 'Main';
      let tableSortState = {}; // { [tableId]: { key, dir } }
      let lastSelected = { tableId: null, rowIdx: null, protocolId: null };
      let autoRefresh = true;
      let autoInterval = null;
      let refreshInterval = 500;
      let lastDataHash = null; // Store hash of last data to detect changes

      function formatJson(val) {
        // Handle File objects
        if (val instanceof File) {
          if (val.type.startsWith('image/') && val.size < 1024 * 1024) { // Less than 1MB
            const url = URL.createObjectURL(val);
            return { 
              html: \`<div style="display:flex;align-items:center;gap:8px;">
                      <img src="\${url}" style="max-width:50px;max-height:50px;border:1px solid #ccc;" 
                           onload="this.nextSibling.style.display='block'" 
                           onerror="this.style.display='none';this.nextSibling.style.display='block'">
                      <div style="display:none;">File: \${val.name} (\${(val.size/1024).toFixed(1)}KB)</div>
                     </div>\`, 
              className: 'file-image' 
            };
          } else {
            return { html: \`File: \${val.name} (\${(val.size/1024).toFixed(1)}KB, \${val.type || 'unknown type'})\`, className: 'file-object' };
          }
        }
        
        // Handle Blob objects
        if (val instanceof Blob) {
          if (val.type.startsWith('image/') && val.size < 1024 * 1024) { // Less than 1MB
            const url = URL.createObjectURL(val);
            return { 
              html: \`<div style="display:flex;align-items:center;gap:8px;">
                      <img src="\${url}" style="max-width:50px;max-height:50px;border:1px solid #ccc;" 
                           onload="this.nextSibling.style.display='block'" 
                           onerror="this.style.display='none';this.nextSibling.style.display='block'">
                      <div style="display:none;">Blob (\${(val.size/1024).toFixed(1)}KB)</div>
                     </div>\`, 
              className: 'blob-image' 
            };
          } else {
            return { html: \`Blob (\${(val.size/1024).toFixed(1)}KB, \${val.type || 'unknown type'})\`, className: 'blob-object' };
          }
        }

        if (Array.isArray(val)) {
          // Show summary, allow user to expand/collapse
          const summary = 'Array['+val.length+']';
          return { html: '<details><summary>'+summary+'</summary><pre>'+escapeHtml(JSON.stringify(val,null,2))+'</pre></details>', className: 'json-array' };
        }
        if (typeof val === 'object' && val !== null) {
          // Show summary, allow user to expand/collapse
          return { html: '<details><summary>Object</summary><pre>'+escapeHtml(JSON.stringify(val,null,2))+'</pre></details>', className: 'json-object' };
        }
        if (val === null) return { html: 'null', className: '' };
        if (typeof val === 'number' && val < 0) {
          return { html: '⚠️ ' + String(val), className: '' };
        }
        return { html: String(val), className: '' };
      }

      function escapeHtml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function compareValues(a, b) {
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        if (a === null) return 1;
        if (b === null) return -1;
        if (typeof a === "number" && typeof b === "number") return a - b;
        if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
        return String(a).localeCompare(String(b));
      }

      function generateDataHash(dbs) {
        // Create a hash of the data to detect changes
        if (!dbs || !dbs.length) return '';
        try {
          return JSON.stringify(dbs, (key, value) => {
            // Skip Blob/File objects in hash as they can't be serialized
            if (value instanceof Blob || value instanceof File) {
              return \`\${value.constructor.name}:\${value.size}:\${value.type}\`;
            }
            return value;
          });
        } catch(e) {
          return Math.random().toString(); // Force update if serialization fails
        }
      }

      function makeTable(rows, tableId) {
        if(!rows.length) return '<p>(Empty)</p>';
        const keys = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
        let sortedRows = rows.slice();
        const sort = tableSortState[tableId];
        if (sort && sort.key) {
          sortedRows.sort((a, b) => {
            const cmp = compareValues(a[sort.key], b[sort.key]);
            return sort.dir === 'asc' ? cmp : -cmp;
          });
        }
        let html = '<table data-tableid="'+tableId+'"><thead><tr>';
        keys.forEach(k => {
          let thClass = (k==='version'?'version':'');
          if (sort && sort.key === k) thClass += ' sorted-' + sort.dir;
          html += '<th class="'+thClass+'" data-key="'+k+'">'+k+'</th>';
        });
        html += '</tr></thead><tbody>';
        sortedRows.forEach((row, idx) => {
          let trClass = '';
          if (lastSelected.tableId === tableId && lastSelected.rowIdx === idx) {
            trClass = 'selected-row';
          } else if (lastSelected.protocolId !== null && row.protocolId !== undefined && row.protocolId === lastSelected.protocolId) {
            trClass = 'related-row';
          }
          html += '<tr data-rowidx="'+idx+'" class="'+trClass+'">';
          keys.forEach(k => {
            const formatted = formatJson(row[k]);
            html += '<td class="'+(k==='version'?'version ':'')+formatted.className+'">'+formatted.html+'</td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
      }

      function attachTableSortHandlers() {
        document.querySelectorAll('table[data-tableid]').forEach(table => {
          const tableId = table.getAttribute('data-tableid');
          table.querySelectorAll('th[data-key]').forEach(th => {
            th.style.cursor = 'pointer';
            th.onclick = function() {
              const key = th.getAttribute('data-key');
              let state = tableSortState[tableId] || {};
              if (state.key === key) {
                state.dir = state.dir === 'asc' ? 'desc' : 'asc';
              } else {
                state.key = key;
                state.dir = 'asc';
              }
              tableSortState[tableId] = state;
              showTab(lastDbs[0], currentTab);
            };
          });
          table.querySelectorAll('tbody tr').forEach(tr => {
            tr.onclick = function(e) {
              // Prevent row selection when clicking on details/summary elements
              if (e.target.tagName === 'SUMMARY' || e.target.closest('details')) {
                return;
              }
              const rowIdx = parseInt(tr.getAttribute('data-rowidx'), 10);
              const rows = getRowsForTableId(tableId);
              const row = rows && rows[rowIdx];
              let protocolId = null;
              if (row && row.protocolId !== undefined) protocolId = row.protocolId;
              else if (row && row.id !== undefined && tableId === 'protocols') protocolId = row.id;
              else protocolId = null;
              lastSelected = { tableId, rowIdx, protocolId };
              showTab(lastDbs[0], currentTab);
            };
          });
          // Stop event propagation for details/summary elements
          table.querySelectorAll('details, summary').forEach(el => {
            el.addEventListener('click', function(e) {
              e.stopPropagation();
            });
          });
        });
      }

      function getRowsForTableId(tableId) {
        if (!lastDbs.length) return [];
        const db = lastDbs[0];
        return db.stores[tableId] || [];
      }

      function render(dbs){
        // Check if data actually changed
        const newDataHash = generateDataHash(dbs);
        if (lastDataHash === newDataHash && lastDbs.length > 0 && dbs.length > 0) {
          // Data hasn't changed, no need to re-render
          return;
        }
        lastDataHash = newDataHash;

        lastDbs = dbs;
        logEl.textContent = '';
        if(!dbs.length){ contentEl.innerHTML = '<p>No IndexedDB databases</p>'; tabsEl.innerHTML=''; dbNameVerEl.textContent = 'IndexedDB Debug Panel'; return; }
        tabsEl.innerHTML = '';
        const tabNames = ['Main', 'Protocols', 'Header'];
        tabNames.forEach(tabName => {
          const tab = document.createElement('div');
          tab.className = 'tab' + (tabName === currentTab ? ' active' : '');
          tab.textContent = tabName;
          tab.onclick = () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tabName;
            showTab(dbs[0], tabName);
            dbNameVerEl.textContent = dbs[0].name + (dbs[0].version ? ' (v'+dbs[0].version+')' : '');
          };
          tabsEl.appendChild(tab);
        });
        showTab(dbs[0], currentTab);
        dbNameVerEl.textContent = dbs[0].name + (dbs[0].version ? ' (v'+dbs[0].version+')' : '');
        setTimeout(attachTableSortHandlers, 0);
      }

      function showTab(db, tabName){
        let html = '';
        if(tabName === 'Header') {
          ['addresses', 'fibreOnLocations'].forEach(storeName => {
            if(db.stores[storeName]) {
              html += '<h3>'+storeName+' ('+db.stores[storeName].length+')</h3>'+makeTable(db.stores[storeName], storeName);
            }
          });
        } else if(tabName === 'Main') {
          for(const storeName in db.stores){
            if(storeName==='addresses'||storeName==='fibreOnLocations'||storeName==='protocols') continue;
            html+='<h3>'+storeName+' ('+db.stores[storeName].length+')</h3>'+makeTable(db.stores[storeName], storeName);
          }
        } else if(tabName === 'Protocols') {
          if(db.stores['protocols']) {
            html += '<h3>protocols ('+db.stores['protocols'].length+')</h3>'+makeTable(db.stores['protocols'], 'protocols');
          } else {
            html = '<p>(No data for protocols)</p>';
          }
        }
        contentEl.innerHTML = html || '<p>(Empty)</p>';
        setTimeout(attachTableSortHandlers, 0);
      }

      window.addEventListener('message',e=>{
        const data = e.data;
        if(data.type==='dbList') render(data.dbs);
        if(data.type==='autoState') window.autoRefreshSet(data.enabled);
        if(data.type==='intervalState') window.setRefreshInterval(data.interval);
      });

      refreshBtn.onclick = () => {
        logEl.textContent = 'Refreshing data...';
        window.opener?.postMessage({type:'refreshRequest'}, '*');
      };

      autoRefreshCb.onchange = function() {
        window.opener?.postMessage({type:'toggleAuto', enabled:this.checked}, '*');
      };

      refreshIntervalInput.onchange = function() {
        const interval = parseInt(this.value, 10);
        if (interval >= 100 && interval <= 10000) {
          window.opener?.postMessage({type:'updateInterval', interval: interval}, '*');
        }
      };

      window.autoRefreshSet = function(enabled) {
        autoRefreshCb.checked = !!enabled;
      };

      window.setRefreshInterval = function(interval) {
        refreshIntervalInput.value = interval;
      };
    <\/script>
  </body></html>
`);

    debugWin.document.close();

    async function sendAllIDBToPopup(){
        // Reset previous state to force re-search
        let infos = [];

        // Check if IndexedDB is available
        if (!window.indexedDB) {
            debugWin.postMessage({type:'dbList', dbs: []}, '*');
            return;
        }

        // Always try to get fresh database list
        if(indexedDB.databases) {
            try {
                infos = await indexedDB.databases();
            } catch(e) {
                console.warn('indexedDB.databases() failed:', e);
                infos = [];
            }
        }

        // Always search for construction-documentation-ui-db
        let targetDb = null;
        if (infos.length) {
            targetDb = infos.find(db => db.name === 'construction-documentation-ui-db');
        }

        // If not found in list, try direct connection
        if (!targetDb) {
            try {
                const testDb = await new Promise((resolve, reject) => {
                    const openReq = indexedDB.open('construction-documentation-ui-db');
                    openReq.onerror = () => reject(openReq.error);
                    openReq.onsuccess = () => resolve(openReq.result);
                    openReq.onupgradeneeded = () => {
                        openReq.result.close();
                        reject(new Error('Database does not exist'));
                    };
                });

                if (testDb.objectStoreNames.length > 0) {
                    targetDb = { name: 'construction-documentation-ui-db', version: testDb.version };
                }
                testDb.close();
            } catch(e) {
                console.warn('Database search failed:', e);
            }
        }

        if(!targetDb) {
            debugWin.postMessage({type:'dbList', dbs: []}, '*');
            return;
        }

        // Process the target database
        try {
            const db = await new Promise((resolve, reject) => {
                const openReq = indexedDB.open(targetDb.name, targetDb.version);
                openReq.onerror = () => reject(openReq.error);
                openReq.onsuccess = () => resolve(openReq.result);
            });
            const stores = {};
            for(const storeName of db.objectStoreNames){
                stores[storeName] = await new Promise(resolve => {
                    try {
                        const tx = db.transaction(storeName, 'readonly');
                        const req = tx.objectStore(storeName).getAll();
                        req.onsuccess=()=>resolve(req.result);
                        req.onerror=()=>resolve([]);
                    }catch{ resolve([]); }
                });
            }
            db.close();
            debugWin.postMessage({type:'dbList', dbs: [{name: targetDb.name, stores, version: targetDb.version}]}, '*');
        } catch(e) {
            console.warn('Failed to open database:', targetDb.name, e);
            debugWin.postMessage({type:'dbList', dbs: []}, '*');
        }
    }

    // Auto-refresh management
    function setAutoRefresh(enabled) {
        autoRefresh = enabled;
        debugWin.postMessage({type:'autoState', enabled: autoRefresh}, '*');
        if (autoInterval) {
            clearInterval(autoInterval);
            autoInterval = null;
        }
        if (enabled) {
            autoInterval = setInterval(sendAllIDBToPopup, refreshInterval);
        }
    }

    function updateRefreshInterval(newInterval) {
        refreshInterval = newInterval;
        debugWin.postMessage({type:'intervalState', interval: refreshInterval}, '*');
        if (autoRefresh) {
            setAutoRefresh(false);
            setAutoRefresh(true);
        }
    }

    // Initial run
    sendAllIDBToPopup();
    setAutoRefresh(true);
    debugWin.postMessage({type:'intervalState', interval: refreshInterval}, '*');

    window.addEventListener('message', e=>{
        if(e.source!==debugWin) return;
        const data = e.data;
        if(data && data.type==='refreshRequest') sendAllIDBToPopup();
        if(data && data.type==='toggleAuto') setAutoRefresh(Boolean(data.enabled));
        if(data && data.type==='updateInterval') updateRefreshInterval(data.interval);
    });

})();
